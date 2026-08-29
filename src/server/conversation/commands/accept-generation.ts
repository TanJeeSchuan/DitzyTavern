import type { Database } from "bun:sqlite";
import { and, eq, isNull, max, sql } from "drizzle-orm";
import {
	activeGenerationTable,
	chatTable,
	conversationGenerationSettingsTable,
	messageTable,
	messageVariantDataTable,
	messageVariantTable,
	participantPromptTable,
	participantTable,
} from "../../database/schema";
import {
	ConversationNotFoundError,
	ConversationNotPlayableError,
	InvalidConversationCommandError,
	SiblingVariantUnavailableError,
	StaleConversationRevisionError,
} from "../errors";
import {
	connectConversationDatabase,
	isPlayable,
	readControlAssignment,
	requireMessage,
	requireParticipant,
} from "../internal";
import { deriveMessageSwipeEligibility } from "../snapshot";
import {
	advanceConversationRevision,
	advanceConversationRevisionGuarded,
	requireConversationSnapshot,
	runConversationTransaction,
} from "./transaction";
import { isSiblingGenerationRow } from "./active-generation";
import type {
	AcceptedTailGeneration,
	AcceptedSiblingGeneration,
	AcceptedContinuationGeneration,
	AcceptSiblingGenerationInput,
	AcceptContinuationGenerationInput,
	AcceptTailGenerationInput,
	ConversationDataEntry,
	ConversationJsonValue,
	ConversationSnapshot,
} from "../types";

// Acceptance seams for the server-owned Generation lifecycles. Every accept
// commits its lifecycle's target and the Active Generation row in one
// immediate transaction owned by the shared transaction seam; the terminal
// transitions (resolve/remove/stop/checkpoint) live in active-generation.ts.

const jsonText = (
	value: ConversationJsonValue,
	label: string,
): string => {
	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) throw new Error("undefined");
		return serialized;
	} catch {
		throw new InvalidConversationCommandError(
			`The captured ${label} could not be persisted as JSON.`,
		);
	}
};

const ensureConversationRevision = (
	db: ReturnType<typeof connectConversationDatabase>,
	conversationId: number,
	expectedRevision: number,
) => {
	const conversation = db
		.select({ id: chatTable.id, revision: chatTable.revision })
		.from(chatTable)
		.where(eq(chatTable.id, conversationId))
		.get();
	if (conversation === undefined) throw new ConversationNotFoundError(conversationId);
	if (conversation.revision !== expectedRevision) {
		throw new StaleConversationRevisionError(expectedRevision, conversation.revision);
	}
	return conversation;
};

interface PersistActiveGenerationInput {
	conversationId: number;
	humanMessageId: number | null;
	messageId: number;
	variantId: number;
	priorVariantId?: number | null;
	humanParticipantId: number;
	modelParticipantId: number;
	capturedHumanName: string;
	capturedModelName: string;
	startedAt: string;
	promptPlan: ConversationJsonValue;
	promptInspection?: ConversationJsonValue;
	historyRoles: readonly ("human" | "model" | null)[];
	generationSettings: ConversationJsonValue;
	connection: ConversationJsonValue;
	generationIntent: ConversationJsonValue;
	provenance?: ConversationDataEntry;
}

/** Persist the common server-owned Generation record after target creation. */
const persistActiveGeneration = (
	db: ReturnType<typeof connectConversationDatabase>,
	input: PersistActiveGenerationInput,
): number => {
	const active = db
		.insert(activeGenerationTable)
		.values({
			chat_id: input.conversationId,
			human_message_id: input.humanMessageId,
			message_id: input.messageId,
			variant_id: input.variantId,
			prior_variant_id: input.priorVariantId ?? null,
			human_participant_id: input.humanParticipantId,
			model_participant_id: input.modelParticipantId,
			captured_human_name: input.capturedHumanName,
			captured_model_name: input.capturedModelName,
			started_at: input.startedAt,
			prompt_plan_json: jsonText(input.promptPlan, "Prompt Plan"),
			prompt_inspection_json: jsonText(input.promptInspection ?? {}, "Prompt inspection"),
			history_roles_json: jsonText(input.historyRoles, "Prompt history roles"),
			generation_settings_json: jsonText(input.generationSettings, "Generation Settings"),
			connection_json: jsonText(input.connection, "Connection identity"),
			generation_intent_json: jsonText(input.generationIntent, "Generation intent"),
			provenance_namespace: input.provenance?.namespace ?? null,
			provenance_key: input.provenance?.key ?? null,
			provenance_value: input.provenance?.value ?? null,
		})
		.returning({ id: activeGenerationTable.id })
		.get();
	if (active === undefined) {
		throw new InvalidConversationCommandError(
			"The Active Generation could not be persisted.",
		);
	}
	return active.id;
};

interface ProvisionalModelTargetInput {
	conversationId: number;
	timestamp: string;
	humanParticipantId: number;
	modelParticipantId: number;
	/** Supply the next position when it was already read as part of validation. */
	position?: number;
}

interface ProvisionalModelTarget {
	modelMessageId: number;
	provisionalVariantId: number;
}

interface ProvisionalSiblingVariant {
	provisionalVariantId: number;
	priorVariantId: number | null;
}

/** Create the model Message and its selected empty Variant as one target. */
const createProvisionalModelTarget = (
	db: ReturnType<typeof connectConversationDatabase>,
	input: ProvisionalModelTargetInput,
): ProvisionalModelTarget => {
	const nextPosition = input.position ?? ((db
		.select({ value: max(messageTable.position) })
		.from(messageTable)
		.where(eq(messageTable.chat_id, input.conversationId))
		.get()?.value ?? 0) + 1);
	const model = requireParticipant(db, input.conversationId, input.modelParticipantId);
	const message = db
		.insert(messageTable)
		.values({
			chat_id: input.conversationId,
			position: nextPosition,
			timestamp: input.timestamp,
			author_participant_id: model.id,
			author_name: model.name,
			context_human_participant_id: input.humanParticipantId,
			context_model_participant_id: model.id,
		})
		.returning({ id: messageTable.id })
		.get();
	if (message === undefined) {
		throw new InvalidConversationCommandError(
			"The provisional model Message could not be persisted.",
		);
	}
	const variant = db
		.insert(messageVariantTable)
		.values({
			message_id: message.id,
			position: 1,
			content: "",
			timestamp: input.timestamp,
			selected: true,
		})
		.returning({ id: messageVariantTable.id })
		.get();
	if (variant === undefined) {
		throw new InvalidConversationCommandError(
			"The provisional model Variant could not be persisted.",
		);
	}
	return { modelMessageId: message.id, provisionalVariantId: variant.id };
};

const createProvisionalSiblingVariant = (
	db: ReturnType<typeof connectConversationDatabase>,
	messageId: number,
	timestamp: string,
): ProvisionalSiblingVariant => {
	const priorVariantId = db
		.select({ id: messageVariantTable.id })
		.from(messageVariantTable)
		.where(
			and(
				eq(messageVariantTable.message_id, messageId),
				eq(messageVariantTable.selected, true),
			),
		)
		.get()?.id ?? null;
	const position = db
		.select({ value: max(messageVariantTable.position) })
		.from(messageVariantTable)
		.where(eq(messageVariantTable.message_id, messageId))
		.get()?.value ?? 0;
	db.update(messageVariantTable)
		.set({ selected: false })
		.where(eq(messageVariantTable.message_id, messageId))
		.run();
	const variant = db
		.insert(messageVariantTable)
		.values({
			message_id: messageId,
			position: position + 1,
			content: "",
			timestamp,
			selected: true,
		})
		.returning({ id: messageVariantTable.id })
		.get();
	if (variant === undefined) {
		throw new InvalidConversationCommandError(
			"The provisional sibling Variant could not be persisted.",
		);
	}
	return { provisionalVariantId: variant.id, priorVariantId };
};

function hasReasoningData(
	db: ReturnType<typeof connectConversationDatabase>,
	variantId: number,
): boolean {
	const reasoning = db
		.select({ value: messageVariantDataTable.value })
		.from(messageVariantDataTable)
		.where(
			and(
				eq(messageVariantDataTable.message_variant_id, variantId),
				eq(messageVariantDataTable.namespace, "generation"),
				eq(messageVariantDataTable.key, "reasoning"),
			),
		)
		.get();
	return reasoning?.value.length !== 0 && reasoning?.value !== undefined;
}

// The differing mid-acceptance validation: Tail creates or reuses the
// trailing human Message; Continuation validates the preceding terminal
// Message. The result carries the human Message id for the Active
// Generation row (null when the lifecycle has none) and the explicit
// position for the provisional model target (undefined to derive it from
// the current tail).
interface AcceptGenerationValidation {
	humanMessageId: number | null;
	position?: number | undefined;
}

type AcceptGenerationParticipant = ReturnType<typeof requireParticipant>;

interface AcceptGenerationTargetInput<Validation extends AcceptGenerationValidation> {
	conversationId: number;
	expectedRevision: number;
	timestamp: string;
	// The lifecycle name spelled exactly as the shared distinct-seat denial
	// addresses it: "Tail" and "Continuation".
	lifecycle: "Tail" | "Continuation";
	humanParticipantId: number;
	modelParticipantId: number;
	capturedHumanName?: string | undefined;
	capturedModelName: string;
	promptPlan: ConversationJsonValue;
	promptInspection?: ConversationJsonValue | undefined;
	historyRoles: readonly ("human" | "model" | null)[];
	generationSettings: ConversationJsonValue;
	connection: ConversationJsonValue;
	generationIntent: ConversationJsonValue;
	provenance?: ConversationDataEntry | undefined;
	// Lifecycle rejection that must precede the shared seat guards: Send
	// rejects empty composer content ahead of the distinct-seat denial so
	// the original error precedence survives the extraction.
	preflight?: (() => void) | undefined;
	// The differing validation, run inside the transaction after the shared
	// guards; every thrown message keeps its original precedence.
	validate: (
		db: ReturnType<typeof connectConversationDatabase>,
		human: AcceptGenerationParticipant,
		model: AcceptGenerationParticipant,
	) => Validation;
}

interface AcceptedGenerationTarget<Validation extends AcceptGenerationValidation> {
	generationId: number;
	provisional: ProvisionalModelTarget;
	conversation: ConversationSnapshot;
	validation: Validation;
}

/**
 * Shared middle of Tail and Continuation acceptance: the revision guard,
 * the lifecycle preflight, the distinct-seat requirement, the captured
 * Control-pair authority, seat membership, the captured model stamp, the
 * existing-Active check, the differing validation, provisional target
 * creation, Active Generation persistence, the guarded revision bump, and
 * the post-acceptance snapshot. The lifecycles differ only in their
 * preflight and validation hooks, so every error message and its order
 * stay identical to the pre-extraction behavior.
 */
function acceptConversationGenerationTarget<Validation extends AcceptGenerationValidation>(
	database: Database,
	input: AcceptGenerationTargetInput<Validation>,
): AcceptedGenerationTarget<Validation> {
	return runConversationTransaction(database, (db) => {
		ensureConversationRevision(db, input.conversationId, input.expectedRevision);
		input.preflight?.();
		if (input.humanParticipantId === input.modelParticipantId) {
			throw new InvalidConversationCommandError(
				`A ${input.lifecycle} Generation requires distinct human and model Participants.`,
			);
		}
		const control = readControlAssignment(db, input.conversationId);
		if (
			control.humanParticipantId !== input.humanParticipantId ||
			control.modelParticipantId !== input.modelParticipantId
		) {
			throw new InvalidConversationCommandError(
				"The captured Control pair is no longer authoritative.",
			);
		}
		const human = requireParticipant(db, input.conversationId, input.humanParticipantId);
		const model = requireParticipant(db, input.conversationId, input.modelParticipantId);
		if (model.name !== input.capturedModelName) {
			throw new InvalidConversationCommandError(
				"The captured model Author Stamp is no longer authoritative.",
			);
		}
		const existing = db
			.select({ id: activeGenerationTable.id })
			.from(activeGenerationTable)
			.where(eq(activeGenerationTable.chat_id, input.conversationId))
			.get();
		if (existing !== undefined) {
			throw new InvalidConversationCommandError(
				"This Conversation already has an Active Generation.",
			);
		}

		const validation = input.validate(db, human, model);
		const provisional = createProvisionalModelTarget(db, {
			conversationId: input.conversationId,
			timestamp: input.timestamp,
			humanParticipantId: human.id,
			modelParticipantId: model.id,
			position: validation.position,
		});
		const activeGenerationId = persistActiveGeneration(db, {
			conversationId: input.conversationId,
			humanMessageId: validation.humanMessageId,
			messageId: provisional.modelMessageId,
			variantId: provisional.provisionalVariantId,
			humanParticipantId: human.id,
			modelParticipantId: model.id,
			capturedHumanName: input.capturedHumanName ?? human.name,
			capturedModelName: model.name,
			startedAt: input.timestamp,
			promptPlan: input.promptPlan,
			promptInspection: input.promptInspection,
			historyRoles: input.historyRoles,
			generationSettings: input.generationSettings,
			connection: input.connection,
			generationIntent: input.generationIntent,
			provenance: input.provenance,
		});
		advanceConversationRevisionGuarded(
			db,
			input.conversationId,
			input.expectedRevision,
			input.expectedRevision + 1,
			input.timestamp,
		);
		return {
			generationId: activeGenerationId,
			provisional,
			conversation: requireConversationSnapshot(db, input.conversationId),
			validation,
		};
	});
}

// Accepting Send is the lifecycle boundary. The human Message, provisional
// model Message/Variant, and Active Generation row are committed together,
// and the revision guard makes the preflight candidate safe to apply.
export function acceptConversationTailGeneration(
	database: Database,
	input: AcceptTailGenerationInput,
): AcceptedTailGeneration {
	const accepted = acceptConversationGenerationTarget(database, {
		conversationId: input.conversationId,
		expectedRevision: input.expectedRevision,
		timestamp: input.timestamp,
		lifecycle: "Tail",
		humanParticipantId: input.humanParticipantId,
		modelParticipantId: input.modelParticipantId,
		capturedHumanName: input.capturedHumanName,
		capturedModelName: input.capturedModelName,
		promptPlan: input.promptPlan,
		promptInspection: input.promptInspection,
		historyRoles: input.historyRoles,
		generationSettings: input.generationSettings,
		connection: input.connection,
		generationIntent: input.generationIntent ?? { type: "tail" },
		provenance: input.provenance,
		preflight: () => {
			if (input.humanContent.trim() === "") {
				throw new InvalidConversationCommandError(
					"Send requires non-empty composer content.",
				);
			}
		},
		validate: (db, human) => {
			let humanMessageId = input.reuseHumanMessageId;
			if (humanMessageId !== undefined) {
				const reused = requireMessage(db, input.conversationId, humanMessageId);
				const latestPosition = db
					.select({ value: max(messageTable.position) })
					.from(messageTable)
					.where(eq(messageTable.chat_id, input.conversationId))
					.get()?.value;
				const selected = db
					.select({ content: messageVariantTable.content })
					.from(messageVariantTable)
					.where(
						and(
							eq(messageVariantTable.message_id, reused.id),
							eq(messageVariantTable.selected, true),
						),
					)
					.get();
				if (
					reused.position !== latestPosition ||
					reused.author_participant_id !== human.id ||
					reused.author_name !== human.name ||
					selected?.content !== input.humanContent
				) {
					throw new InvalidConversationCommandError(
						"The unanswered human Message cannot be reused for this Send.",
					);
				}
			} else {
				const latestPosition = db
					.select({ value: max(messageTable.position) })
					.from(messageTable)
					.where(eq(messageTable.chat_id, input.conversationId))
					.get()?.value;
				const insertedHuman = db
					.insert(messageTable)
					.values({
						chat_id: input.conversationId,
						position: (latestPosition ?? 0) + 1,
						timestamp: input.timestamp,
						author_participant_id: human.id,
						author_name: human.name,
					})
					.returning({ id: messageTable.id })
					.get();
				if (insertedHuman === undefined) {
					throw new InvalidConversationCommandError(
						"The human Message could not be persisted.",
					);
				}
				humanMessageId = insertedHuman.id;
				db.insert(messageVariantTable)
					.values({
						message_id: insertedHuman.id,
						position: 1,
						content: input.humanContent,
						timestamp: input.timestamp,
						selected: true,
					})
					.run();
			}

			if (humanMessageId === undefined) {
				throw new InvalidConversationCommandError(
					"The provisional model Message could not be persisted.",
				);
			}
			return { humanMessageId };
		},
	});
	return {
		generationId: accepted.generationId,
		humanMessageId: accepted.validation.humanMessageId,
		modelMessageId: accepted.provisional.modelMessageId,
		provisionalVariantId: accepted.provisional.provisionalVariantId,
		conversation: accepted.conversation,
	};
}

// Continuation acceptance is the same server-owned lifecycle as Send, except
// it creates only the new model-authored Message and its Provisional Variant.
// The preceding selected model Message is validated in the same transaction
// so a stale client can never continue a changed narrative position.
export function acceptConversationContinuationGeneration(
	database: Database,
	input: AcceptContinuationGenerationInput,
): AcceptedContinuationGeneration {
	const accepted = acceptConversationGenerationTarget(database, {
		conversationId: input.conversationId,
		expectedRevision: input.expectedRevision,
		timestamp: input.timestamp,
		lifecycle: "Continuation",
		humanParticipantId: input.humanParticipantId,
		modelParticipantId: input.modelParticipantId,
		capturedHumanName: input.capturedHumanName,
		capturedModelName: input.capturedModelName,
		promptPlan: input.promptPlan,
		promptInspection: input.promptInspection,
		historyRoles: input.historyRoles,
		generationSettings: input.generationSettings,
		connection: input.connection,
		generationIntent: input.generationIntent ?? { type: "continuation", strategy: "instruction" },
		provenance: input.provenance,
		validate: (db, _human, model) => {
			const latest = db
				.select({ id: messageTable.id, position: messageTable.position })
				.from(messageTable)
				.where(eq(messageTable.chat_id, input.conversationId))
				.orderBy(sql`${messageTable.position} DESC`)
				.limit(1)
				.get();
			if (latest === undefined || latest.id !== input.precedingMessageId) {
				throw new InvalidConversationCommandError(
					"Continue is available only at the end of the Conversation.",
				);
			}
			const preceding = requireMessage(db, input.conversationId, input.precedingMessageId);
			const precedingWasModelAuthored = preceding.author_participant_id !== null &&
				(preceding.author_participant_id === model.id ||
					preceding.context_model_participant_id === preceding.author_participant_id);
			if (!precedingWasModelAuthored) {
				throw new InvalidConversationCommandError(
					"Continue is available only after a model-authored Message.",
				);
			}
			const selected = db
				.select({ content: messageVariantTable.content })
				.from(messageVariantTable)
				.where(
					and(
						eq(messageVariantTable.message_id, preceding.id),
						eq(messageVariantTable.id, input.precedingVariantId),
						eq(messageVariantTable.selected, true),
					),
				)
				.get();
			if (selected === undefined || (selected.content.length === 0 && !hasReasoningData(db, input.precedingVariantId))) {
				throw new InvalidConversationCommandError(
					"Continue requires a terminal Variant with visible or reasoning Content.",
				);
			}
			return { humanMessageId: null, position: latest.position + 1 };
		},
	});
	return {
		generationId: accepted.generationId,
		modelMessageId: accepted.provisional.modelMessageId,
		provisionalVariantId: accepted.provisional.provisionalVariantId,
		conversation: accepted.conversation,
	};
}

// Sibling acceptance is intentionally revision-neutral: several sibling
// attempts may reserve the same response position in parallel, and each
// reservation advances the Conversation revision independently. Tail and
// Continuation acceptance still reject every existing Active Generation.
export function acceptConversationSiblingGeneration(
	database: Database,
	input: AcceptSiblingGenerationInput,
): AcceptedSiblingGeneration {
	return runConversationTransaction(database, (db) => {
		const conversation = db
			.select({ id: chatTable.id })
			.from(chatTable)
			.where(eq(chatTable.id, input.conversationId))
			.get();
		if (conversation === undefined) throw new ConversationNotFoundError(input.conversationId);
		if (input.humanParticipantId === input.modelParticipantId) {
			throw new InvalidConversationCommandError(
				"A Sibling Generation requires distinct historical Participants.",
			);
		}
		const human = requireParticipant(db, input.conversationId, input.humanParticipantId);

		const control = readControlAssignment(db, input.conversationId);
		const message = requireMessage(db, input.conversationId, input.messageId);
		const historicalContext = message.context_human_participant_id !== null &&
			message.context_model_participant_id !== null
			? {
				humanParticipantId: message.context_human_participant_id,
				modelParticipantId: message.context_model_participant_id,
			}
			: null;
		const castIds = db
			.select({ id: participantTable.id })
			.from(participantTable)
			.innerJoin(
				participantPromptTable,
				eq(participantPromptTable.participant_id, participantTable.id),
			)
			.where(
				and(
					eq(participantTable.chat_id, input.conversationId),
					isNull(participantTable.deleted_at),
				),
			)
			.all()
			.map((participant) => participant.id);
		const playable = isPlayable(control) &&
			control.humanParticipantId !== control.modelParticipantId &&
			control.humanParticipantId !== null &&
			control.modelParticipantId !== null &&
			castIds.includes(control.humanParticipantId) &&
			castIds.includes(control.modelParticipantId);
		const eligibility = deriveMessageSwipeEligibility(
			playable,
			historicalContext,
			castIds,
		);
		if (!eligibility.eligible) {
			if (eligibility.reason === "conversation-not-playable") {
				throw new ConversationNotPlayableError(input.conversationId);
			}
			throw new SiblingVariantUnavailableError(eligibility.reason);
		}
		if (historicalContext === null) {
			throw new SiblingVariantUnavailableError("missing-historical-context");
		}
		if (
			historicalContext.humanParticipantId !== input.humanParticipantId ||
			historicalContext.modelParticipantId !== input.modelParticipantId
		) {
			throw new SiblingVariantUnavailableError("missing-historical-context");
		}

		const activeRows = db
			.select({ id: activeGenerationTable.id, messageId: activeGenerationTable.message_id, intent: activeGenerationTable.generation_intent_json })
			.from(activeGenerationTable)
			.where(eq(activeGenerationTable.chat_id, input.conversationId))
			.all();
		if (activeRows.some((row) => !isSiblingGenerationRow({ generation_intent_json: row.intent }))) {
			throw new InvalidConversationCommandError(
				"A Sibling Generation cannot start while another response Generation is active.",
			);
		}
		if (activeRows.some((row) => row.messageId !== input.messageId)) {
			throw new InvalidConversationCommandError(
				"Sibling Generations are allowed only at the active response position.",
			);
		}
		const configuredLimit = db
			.select({ value: conversationGenerationSettingsTable.sibling_generation_limit })
			.from(conversationGenerationSettingsTable)
			.where(eq(conversationGenerationSettingsTable.chat_id, input.conversationId))
			.get()?.value ?? 4;
		if (activeRows.length >= configuredLimit) {
			throw new InvalidConversationCommandError(
				`The Conversation already has ${configuredLimit} active Sibling Generations at this response position.`,
			);
		}

		const provisional = createProvisionalSiblingVariant(
			db,
			input.messageId,
			input.timestamp,
		);
		const activeGenerationId = persistActiveGeneration(db, {
			conversationId: input.conversationId,
			humanMessageId: null,
			messageId: input.messageId,
			variantId: provisional.provisionalVariantId,
			priorVariantId: provisional.priorVariantId,
			humanParticipantId: input.humanParticipantId,
			modelParticipantId: input.modelParticipantId,
			capturedHumanName: input.capturedHumanName ?? human.name,
			capturedModelName: input.capturedModelName,
			startedAt: input.timestamp,
			promptPlan: input.promptPlan,
			promptInspection: input.promptInspection,
			historyRoles: input.historyRoles,
			generationSettings: input.generationSettings,
			connection: input.connection,
			generationIntent: input.generationIntent ?? { type: "sibling" },
			provenance: input.provenance,
		});
		const snapshot = advanceConversationRevision(db, input.conversationId, input.timestamp);
		return {
			generationId: activeGenerationId,
			messageId: input.messageId,
			provisionalVariantId: provisional.provisionalVariantId,
			priorVariantId: provisional.priorVariantId,
			conversation: snapshot,
		};
	});
}
