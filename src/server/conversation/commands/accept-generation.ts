import { readVariantData } from "../variant-data";
import { generationJsonObject } from "../../../shared/generation-provenance";
import { authorRoleOf, continuationEligibility } from "../continuation";
import { toAuthorStamp, toHistoricalContext } from "../message-read-projection";
import type { Database } from "bun:sqlite";
import { and, eq, max, sql } from "drizzle-orm";
import {
	activeGenerationTable,
	conversationGenerationSettingsTable,
	messageTable,
	messageVariantTable,
} from "../../database/schema";
import {
	ConversationNotPlayableError,
	InvalidConversationCommandError,
	SiblingVariantUnavailableError,
} from "../errors";
import {
	appendSelectedVariant,
	hasActiveGenerationFromConnection,
	insertMessage,
	insertVariant,
	readActiveCast,
	readControlAssignment,
	requireConversation,
	requireConversationRevision,
	requireMessage,
	requireParticipant,
	type ConversationDatabase,
	type ParticipantRow,
} from "../internal";
import { DEFAULT_SIBLING_GENERATION_LIMIT } from "../../database/schema";
import {
	deriveControlValidity,
	deriveMessageSwipeEligibility,
} from "../snapshot";
import {
	advanceConversationRevision,
	advanceConversationRevisionGuarded,
	requireConversationSummary,
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
	ConversationJsonValue,
	ConversationSummary,
} from "../types";
import { encodeMacroVariableWrite } from "../../../shared/contract/macro-variable-write";
import { isLoreActivationRecord } from "../../../shared/contract/lore-activation";
import { isMemoryActivationRecord } from "../../../shared/contract/memory-recall";
import type { ConversationMemoryChange } from "../../../shared/contract/conversation-memory-change";

// @approved
//  Acceptance seams for the server-owned Generation lifecycles. Every accept
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

type GenerationAcceptanceFields = Pick<AcceptTailGenerationInput,
	"conversationId" | "timestamp" | "humanParticipantId" | "modelParticipantId" |
	"capturedHumanName" | "capturedModelName" | "promptPlan" | "promptInspection" |
	"promptContext" | "generationSettings" | "connection" | "loreActivation" | "memoryActivation" | "generationIntent" |
	"provenance" | "macroPresetId" | "macroWrites"
>;

type GenerationAcceptanceContext = Omit<GenerationAcceptanceFields, "generationIntent">;

interface PersistActiveGenerationInput
	extends GenerationAcceptanceContext {
	humanMessageId: number | null;
	messageId: number;
	variantId: number;
	priorVariantId?: number | null;
	generationIntent: ConversationJsonValue;
}

/** @approved Persist the common server-owned Generation record after target creation. */
const persistActiveGeneration = (
	db: ConversationDatabase,
	input: PersistActiveGenerationInput,
): number => {
	const loreActivation = input.loreActivation ?? null;
	if (loreActivation !== null && !isLoreActivationRecord(loreActivation)) {
		throw new InvalidConversationCommandError(
			"The Lore Activation Record does not match the canonical schema.",
		);
	}
	const memoryActivation = input.memoryActivation ?? null;
	if (memoryActivation !== null && !isMemoryActivationRecord(memoryActivation)) {
		throw new InvalidConversationCommandError("The Memory Activation Record does not match the canonical schema.");
	}
	const active = db
		.insert(activeGenerationTable)
		.values({
			conversation_id: input.conversationId,
			human_message_id: input.humanMessageId,
			message_id: input.messageId,
			variant_id: input.variantId,
			prior_variant_id: input.priorVariantId ?? null,
			human_participant_id: input.humanParticipantId,
			model_participant_id: input.modelParticipantId,
			captured_human_name: input.capturedHumanName,
			captured_model_name: input.capturedModelName,
			started_at: input.timestamp,
			prompt_plan_json: jsonText(input.promptPlan, "Prompt Plan"),
			prompt_inspection_json: jsonText(input.promptInspection ?? {}, "Prompt inspection"),
			prompt_context_json: jsonText(input.promptContext, "Prompt context"),
			generation_settings_json: jsonText(input.generationSettings, "Generation Settings"),
			connection_json: jsonText(input.connection, "Connection identity"),
			lore_activation_json: jsonText(loreActivation, "Lore activation evidence"),
			memory_activation_json: jsonText(memoryActivation, "Memory activation evidence"),
			generation_intent_json: jsonText(input.generationIntent, "Generation intent"),
			provenance_namespace: input.provenance?.namespace ?? null,
			provenance_key: input.provenance?.key ?? null,
			provenance_value: input.provenance?.value ?? null,
			macro_preset_id: input.macroPresetId ?? null,
			macro_writes_json: jsonText(
				(input.macroWrites ?? []).map(encodeMacroVariableWrite),
				"Macro writes",
			),
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
	/** @approved The next Message position, read once by the lifecycle's validation. */
	position: number;
}

interface ProvisionalModelTarget {
	modelMessageId: number;
	provisionalVariantId: number;
}

interface ProvisionalSiblingVariant {
	provisionalVariantId: number;
	priorVariantId: number | null;
}

/** @approved Create the model Message and its selected empty Variant as one target. */
const createProvisionalModelTarget = (
	db: ConversationDatabase,
	input: ProvisionalModelTargetInput,
): ProvisionalModelTarget => {
	const model = requireParticipant(db, input.conversationId, input.modelParticipantId);
	const modelMessageId = insertMessage(db, {
		conversationId: input.conversationId,
		position: input.position,
		timestamp: input.timestamp,
		author: { participantId: model.id, name: model.name },
		context: {
			humanParticipantId: input.humanParticipantId,
			modelParticipantId: model.id,
		},
	});
	const provisionalVariantId = insertVariant(db, {
		messageId: modelMessageId,
		position: 1,
		content: "",
		timestamp: input.timestamp,
		selected: true,
	});
	return { modelMessageId, provisionalVariantId };
};

const createProvisionalSiblingVariant = (
	db: ConversationDatabase,
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
	const provisionalVariantId = appendSelectedVariant(db, {
		messageId,
		content: "",
		timestamp,
	});
	return { provisionalVariantId, priorVariantId };
};

// @approved
//  The differing mid-acceptance validation: Tail creates or reuses the
// trailing human Message; Continuation validates the preceding terminal
// Message. The result carries the human Message id for the Active
// Generation row (null when the lifecycle has none) and the explicit
// position for the provisional model target (undefined to derive it from
// the current tail).
interface AcceptGenerationValidation {
	humanMessageId: number | null;
	position: number;
}

interface AcceptGenerationTargetInput<Validation extends AcceptGenerationValidation>
	extends GenerationAcceptanceContext {
	expectedRevision: number;
	// @approved
	//  The lifecycle name spelled exactly as the shared distinct-seat denial
	// addresses it: "Tail" and "Continuation".
	lifecycle: "Tail" | "Continuation";
	generationIntent: ConversationJsonValue;
	// @approved
	//  Lifecycle rejection that must precede the shared seat guards: Send
	// rejects empty composer content ahead of the distinct-seat denial so
	// the original error precedence survives the extraction.
	preflight?: (() => void) | undefined;
	// @approved
	//  The differing validation, run inside the transaction after the shared
	// guards; every thrown message keeps its original precedence.
	validate: (
		db: ConversationDatabase,
		human: ParticipantRow,
		model: ParticipantRow,
	) => Validation;
}

interface AcceptedGenerationTarget<Validation extends AcceptGenerationValidation> {
	generationId: number;
	provisional: ProvisionalModelTarget;
	conversation: ConversationSummary;
	validation: Validation;
}

// @approved
//  One Human Message's selected Variants as the Memory change record
// for Tail acceptance; the replace-or-create Human Message is the only
// accepted state Memory re-derives.
const tailHumanChange = (
	db: ConversationDatabase,
	conversationId: number,
	humanMessageId: number,
): ConversationMemoryChange => ({
	conversationId,
	touchedVariantIds: db
		.select({ id: messageVariantTable.id })
		.from(messageVariantTable)
		.where(
			and(
				eq(messageVariantTable.message_id, humanMessageId),
				eq(messageVariantTable.selected, true),
			),
		)
		.all()
		.map(({ id }) => id),
	removedVariantIds: [],
	promptPresetChanged: false,
});

/** @approved
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
	return runConversationTransaction(database, (db, reportChange) => {
		requireConversationRevision(db, input.conversationId, input.expectedRevision, "generation");
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
		if (hasActiveGenerationFromConnection(db, input.conversationId)) {
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
			...input,
			humanMessageId: validation.humanMessageId,
			messageId: provisional.modelMessageId,
			variantId: provisional.provisionalVariantId,
			capturedHumanName: input.capturedHumanName ?? human.name,
			capturedModelName: model.name,
		});
		advanceConversationRevisionGuarded(
			db,
			input.conversationId,
			input.expectedRevision,
			input.expectedRevision + 1,
			input.timestamp,
		);
		const conversation = requireConversationSummary(db, input.conversationId);
		if (input.lifecycle === "Tail" && validation.humanMessageId !== null) {
			// @approved
			//  The accepted Human Message is reported through its selected
			// Variants so Memory re-derives the Human source after the commit.
			reportChange(tailHumanChange(db, input.conversationId, validation.humanMessageId));
		}
		return {
			generationId: activeGenerationId,
			provisional,
			conversation,
			validation,
		};
	});
}

// @approved
//  Accepting Send is the lifecycle boundary. The human Message, provisional
// model Message/Variant, and Active Generation row are committed together,
// and the revision guard makes the preflight candidate safe to apply.
export function acceptConversationTailGeneration(
	database: Database,
	input: AcceptTailGenerationInput,
): AcceptedTailGeneration {
	const accepted = acceptConversationGenerationTarget(database, {
		...input,
		lifecycle: "Tail",
		generationIntent: input.generationIntent ?? { type: "tail" },
		preflight: () => {
			if (input.humanContent.trim() === "") {
				throw new InvalidConversationCommandError(
					"Send requires non-empty composer content.",
				);
			}
		},
		validate: (db, human) => {
			const reused = input.reuseHumanMessageId === undefined
				? undefined
				: requireMessage(db, input.conversationId, input.reuseHumanMessageId);
			const latestPosition = db
				.select({ value: max(messageTable.position) })
				.from(messageTable)
				.where(eq(messageTable.conversation_id, input.conversationId))
				.get()?.value;
			if (reused !== undefined) {
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
				return { humanMessageId: reused.id, position: (latestPosition ?? 0) + 1 };
			}
			const humanMessageId = insertMessage(db, {
		conversationId: input.conversationId,
				position: (latestPosition ?? 0) + 1,
				timestamp: input.timestamp,
				author: { participantId: human.id, name: human.name },
				context: null,
			});
			insertVariant(db, {
				messageId: humanMessageId,
				position: 1,
				content: input.humanContent,
				timestamp: input.timestamp,
				selected: true,
			});
			// @approved
			//  The provisional model target follows the just-inserted Human
			// Message, so its position is the one this validation created plus one —
			// derived from the position read here instead of re-reading max(position).
			return { humanMessageId, position: (latestPosition ?? 0) + 2 };
		},
	});
	return {
		generationId: accepted.generationId,
		humanMessageId: accepted.validation.humanMessageId,
		messageId: accepted.provisional.modelMessageId,
		provisionalVariantId: accepted.provisional.provisionalVariantId,
		conversation: accepted.conversation,
	};
}

// @approved
//  Continuation acceptance is the same server-owned lifecycle as Send, except
// it creates only the new model-authored Message and its Provisional Variant.
// The preceding selected model Message is validated in the same transaction
// so a stale client can never continue a changed narrative position.
export function acceptConversationContinuationGeneration(
	database: Database,
	input: AcceptContinuationGenerationInput,
): AcceptedContinuationGeneration {
	const accepted = acceptConversationGenerationTarget(database, {
		...input,
		lifecycle: "Continuation",
		generationIntent: input.generationIntent ?? { type: "continuation", strategy: "instruction" },
		validate: (db, human, model) => {
			const latest = db
				.select({ id: messageTable.id, position: messageTable.position })
				.from(messageTable)
				.where(eq(messageTable.conversation_id, input.conversationId))
				.orderBy(sql`${messageTable.position} DESC`)
				.limit(1)
				.get();
			if (latest === undefined || latest.id !== input.precedingMessageId) {
				throw new InvalidConversationCommandError(
					"Continue is available only at the end of the Conversation.",
				);
			}
			const preceding = requireMessage(db, input.conversationId, input.precedingMessageId);
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
			if (selected === undefined) throw new InvalidConversationCommandError("Continue requires the selected terminal Variant.");
			const reason = continuationEligibility({
				authorRole: authorRoleOf({ author: toAuthorStamp(preceding, new Set([human.id, model.id])), historicalContext: toHistoricalContext(preceding) }, { humanParticipantId: human.id, modelParticipantId: model.id }),
				content: selected.content,
				hasReasoning: (readVariantData(db, [input.precedingVariantId], ["reasoning"]).get(input.precedingVariantId)?.reasoning?.length ?? 0) > 0,
			}, generationJsonObject(input.generationIntent)?.strategy === "assistant-prefill" ? "assistant-prefill" : "instruction");
			if (reason !== null) throw new InvalidConversationCommandError("Continue requires terminal model output eligible for this strategy.");
			return { humanMessageId: null, position: latest.position + 1 };
		},
	});
	return {
		generationId: accepted.generationId,
		messageId: accepted.provisional.modelMessageId,
		provisionalVariantId: accepted.provisional.provisionalVariantId,
		conversation: accepted.conversation,
	};
}

// @approved
//  Sibling acceptance is intentionally revision-neutral: several sibling
// attempts may reserve the same response position in parallel, and each
// reservation advances the Conversation revision independently. Tail and
// Continuation acceptance still reject every existing Active Generation.
export function acceptConversationSiblingGeneration(
	database: Database,
	input: AcceptSiblingGenerationInput,
): AcceptedSiblingGeneration {
	return runConversationTransaction(database, (db) => {
		requireConversation(db, input.conversationId);
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
		const castIds = readActiveCast(db, input.conversationId).map(
			(participant) => participant.id,
		);
		const controlValidity = deriveControlValidity(control, castIds);
		const eligibility = deriveMessageSwipeEligibility(
			controlValidity.valid,
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
			throw new InvalidConversationCommandError(
				"The captured historical Control pair does not match the target Message.",
			);
		}

		const activeRows = db
			.select({ id: activeGenerationTable.id, messageId: activeGenerationTable.message_id, intent: activeGenerationTable.generation_intent_json })
			.from(activeGenerationTable)
			.where(eq(activeGenerationTable.conversation_id, input.conversationId))
			.all();
		if (activeRows.some((row) => !isSiblingGenerationRow({ generation_intent_json: row.intent }))) {
			throw new InvalidConversationCommandError(
				"A Sibling Generation cannot start while an Active Generation exists.",
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
			.where(eq(conversationGenerationSettingsTable.conversation_id, input.conversationId))
			.get()?.value ?? DEFAULT_SIBLING_GENERATION_LIMIT;
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
			...input,
			humanMessageId: null,
			messageId: input.messageId,
			variantId: provisional.provisionalVariantId,
			priorVariantId: provisional.priorVariantId,
			capturedHumanName: input.capturedHumanName ?? human.name,
			generationIntent: input.generationIntent ?? { type: "sibling" },
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
