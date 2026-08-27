import type { Database } from "bun:sqlite";
import { and, eq, isNull, max, sql } from "drizzle-orm";
import {
	activeGenerationTable,
	chatTable,
	conversationGenerationSettingsTable,
	messageTable,
	messageVariantTable,
	messageVariantDataTable,
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
import { readConversationSnapshot } from "../snapshot";
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
	RemoveTailGenerationInput,
	RemoveSiblingGenerationInput,
	StopGenerationInput,
	ResolveTailGenerationInput,
	ResolveSiblingGenerationInput,
} from "../types";
import { deriveMessageSwipeEligibility } from "../snapshot";

type CheckpointVariantValues = { content: string; timestamp?: string };

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

const readActiveGeneration = (
	db: ReturnType<typeof connectConversationDatabase>,
	conversationId: number,
	generationId: number,
) => db
	.select()
	.from(activeGenerationTable)
	.where(
		and(
			eq(activeGenerationTable.id, generationId),
			eq(activeGenerationTable.chat_id, conversationId),
		),
	)
	.get();

const isSiblingGenerationRow = (row: { generation_intent_json: string }): boolean => {
	try {
		// SAFETY: generation_intent_json is written only by the typed acceptance
		// seams; malformed legacy values simply expose no sibling discriminator.
		const parsed = JSON.parse(row.generation_intent_json) as { readonly type?: unknown };
		return parsed.type === "sibling";
	} catch {
		return false;
	}
};

// Convert the captured base provenance plus terminal data into the compact
// positive allow-list retained by a Variant. Request overrides and any
// malformed/legacy fields are deliberately dropped here, before persistence.
type ActiveProvenanceJsonObject = { readonly [key: string]: ConversationJsonValue };

const activeProvenanceObject = (
	value: ConversationJsonValue | undefined,
): ActiveProvenanceJsonObject | null => {
	if (Object.prototype.toString.call(value) !== "[object Object]") return null;
	// SAFETY: the object-tag check above establishes the JSON object shape before
	// this projection is used to inspect the allow-listed provenance fields.
	return value as ActiveProvenanceJsonObject;
};

const activeProvenanceNumber = (value: ConversationJsonValue | undefined): number | null => {
	if (Object.prototype.toString.call(value) !== "[object Number]") return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
};

const activeProvenanceString = (value: ConversationJsonValue | undefined): string | null =>
	Object.prototype.toString.call(value) === "[object String]" ? String(value) : null;

interface TerminalUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

const terminalProvenance = (
	active: { provenance_namespace: string | null; provenance_key: string | null; provenance_value: string | null },
	data: readonly ConversationDataEntry[],
): ConversationDataEntry | undefined => {
	if (active.provenance_namespace === null || active.provenance_key === null || active.provenance_value === null) return undefined;
	let source: ActiveProvenanceJsonObject = {};
	try {
		// SAFETY: JSON.parse returns only JSON-compatible scalars, arrays, and
		// objects; activeProvenanceObject validates the object shape below.
		const parsed = activeProvenanceObject(JSON.parse(active.provenance_value) as ConversationJsonValue);
		if (parsed !== null) source = parsed;
	} catch {
		// Replace malformed legacy values with the safe terminal projection.
	}
	const settings = activeProvenanceObject(source.generationSettings) ?? {};
	const generationSettings = {
		temperature: activeProvenanceNumber(settings.temperature),
		topP: activeProvenanceNumber(settings.topP),
		frequencyPenalty: activeProvenanceNumber(settings.frequencyPenalty),
		presencePenalty: activeProvenanceNumber(settings.presencePenalty),
		contextLimit: activeProvenanceNumber(settings.contextLimit),
		responseBudget: activeProvenanceNumber(settings.responseBudget),
		safetyAllowance: activeProvenanceNumber(settings.safetyAllowance),
		siblingGenerationLimit: activeProvenanceNumber(settings.siblingGenerationLimit),
		continuationStrategy: settings.continuationStrategy === "instruction" || settings.continuationStrategy === "assistant-prefill"
			? settings.continuationStrategy
			: null,
		continuationInstruction: activeProvenanceString(settings.continuationInstruction),
		continuationPrefillSuffix: settings.continuationPrefillSuffix === "" || settings.continuationPrefillSuffix === " " || settings.continuationPrefillSuffix === "\n" || settings.continuationPrefillSuffix === "\n\n"
			? settings.continuationPrefillSuffix
			: null,
	};
	let usage: TerminalUsage | null = null;
	const usageEntry = data.find((entry) => entry.namespace === "generation" && entry.key === "usage");
	if (usageEntry !== undefined) {
		try {
			// SAFETY: JSON.parse returns only JSON-compatible scalars, arrays, and
			// objects; activeProvenanceObject validates the usage object below.
			const parsed = activeProvenanceObject(JSON.parse(usageEntry.value) as ConversationJsonValue);
			if (parsed !== null) {
				const next: TerminalUsage = {};
				for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
					const value = activeProvenanceNumber(parsed[key]);
					if (value !== null && value >= 0) next[key] = value;
				}
				if (Object.keys(next).length > 0) usage = next;
			}
		} catch { /* malformed usage remains unavailable */ }
	}
	const finishEntry = data.find((entry) => entry.namespace === "generation" && entry.key === "finish");
	let finishReason = activeProvenanceString(source.finishReason);
	if (finishEntry !== undefined) {
		try {
			// SAFETY: JSON.parse returns only JSON-compatible scalars, arrays, and
			// objects; activeProvenanceObject validates the finish object below.
			const parsed = activeProvenanceObject(JSON.parse(finishEntry.value) as ConversationJsonValue);
			if (parsed !== null) {
				const reason = activeProvenanceString(parsed.reason);
				if (reason === "stop" || reason === "length" || reason === "other") finishReason = reason;
			}
		} catch { /* malformed finish remains unavailable */ }
	}
	if (finishReason !== "stop" && finishReason !== "length" && finishReason !== "other") finishReason = null;
	const outcome = data.find((entry) => entry.namespace === "generation" && entry.key === "outcome")?.value;
	const status = outcome === "length-limited" || outcome === "interrupted" || outcome === "complete"
		? outcome
		: source.status === "length-limited" || source.status === "interrupted" || source.status === "complete"
			? source.status
			: "complete";
	const interruptionCause = data.find((entry) => entry.namespace === "generation" && entry.key === "interruption-cause")?.value
		?? activeProvenanceString(source.interruptionCause);
	const profileId = activeProvenanceNumber(source.connectionProfileId);
	const settingsRevision = activeProvenanceNumber(source.connectionSettingsRevision);
	return {
		namespace: active.provenance_namespace,
		key: active.provenance_key,
		value: JSON.stringify({
			connectionProfileId: profileId,
			connectionSettingsRevision: settingsRevision,
			modelBackend: activeProvenanceString(source.modelBackend),
			adapter: activeProvenanceString(source.adapter),
			modelId: activeProvenanceString(source.modelId),
			generationSettings,
			usage,
			finishReason,
			status,
			interruptionCause,
		}),
	};
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

// Accepting Send is the lifecycle boundary. The human Message, provisional
// model Message/Variant, and Active Generation row are committed together,
// and the revision guard makes the preflight candidate safe to apply.
export function acceptConversationTailGeneration(
	database: Database,
	input: AcceptTailGenerationInput,
): AcceptedTailGeneration {
	const accept = database.transaction(() => {
		const db = connectConversationDatabase(database);
		ensureConversationRevision(db, input.conversationId, input.expectedRevision);
		if (input.humanContent.trim() === "") {
			throw new InvalidConversationCommandError(
				"Send requires non-empty composer content.",
			);
		}

		if (input.humanParticipantId === input.modelParticipantId) {
			throw new InvalidConversationCommandError(
				"A Tail Generation requires distinct human and model Participants.",
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
		const human = requireParticipant(
			db,
			input.conversationId,
			input.humanParticipantId,
		);
		const model = requireParticipant(
			db,
			input.conversationId,
			input.modelParticipantId,
		);
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

		const latestPosition = db
			.select({ value: max(messageTable.position) })
			.from(messageTable)
			.where(eq(messageTable.chat_id, input.conversationId))
			.get()?.value;
		const modelMessage = db
			.insert(messageTable)
			.values({
				chat_id: input.conversationId,
				position: (latestPosition ?? 0) + 1,
				timestamp: input.timestamp,
				author_participant_id: model.id,
				author_name: model.name,
				context_human_participant_id: human.id,
				context_model_participant_id: model.id,
			})
			.returning({ id: messageTable.id })
			.get();
		if (modelMessage === undefined || humanMessageId === undefined) {
			throw new InvalidConversationCommandError(
				"The provisional model Message could not be persisted.",
			);
		}
		const provisional = db
			.insert(messageVariantTable)
			.values({
				message_id: modelMessage.id,
				position: 1,
				content: "",
				timestamp: input.timestamp,
				selected: true,
			})
			.returning({ id: messageVariantTable.id })
			.get();
		if (provisional === undefined) {
			throw new InvalidConversationCommandError(
				"The provisional model Variant could not be persisted.",
			);
		}

		const active = db
			.insert(activeGenerationTable)
			.values({
				chat_id: input.conversationId,
				human_message_id: humanMessageId,
				message_id: modelMessage.id,
				variant_id: provisional.id,
				human_participant_id: human.id,
				model_participant_id: model.id,
				captured_human_name: input.capturedHumanName ?? human.name,
				captured_model_name: model.name,
				started_at: input.timestamp,
				prompt_plan_json: jsonText(input.promptPlan, "Prompt Plan"),
				prompt_inspection_json: jsonText(input.promptInspection ?? {}, "Prompt inspection"),
				history_roles_json: jsonText(input.historyRoles, "Prompt history roles"),
				generation_settings_json: jsonText(input.generationSettings, "Generation Settings"),
				connection_json: jsonText(input.connection, "Connection identity"),
				generation_intent_json: jsonText(
					input.generationIntent ?? { type: "tail" },
					"Generation intent",
				),
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

		const advanced = db
			.update(chatTable)
			.set({ revision: sql`${chatTable.revision} + 1`, last_message_time: input.timestamp })
			.where(
				and(
					eq(chatTable.id, input.conversationId),
					eq(chatTable.revision, input.expectedRevision),
				),
			)
			.returning({ revision: chatTable.revision })
			.get();
		if (advanced === undefined) {
			throw new StaleConversationRevisionError(
				input.expectedRevision,
				input.expectedRevision + 1,
			);
		}
		const conversation = readConversationSnapshot(db, input.conversationId);
		if (conversation === undefined) throw new ConversationNotFoundError(input.conversationId);
		return {
			generationId: active.id,
			humanMessageId,
			modelMessageId: modelMessage.id,
			provisionalVariantId: provisional.id,
			conversation,
		};
	});

	return accept.immediate();
}

// Continuation acceptance is the same server-owned lifecycle as Send, except
// it creates only the new model-authored Message and its Provisional Variant.
// The preceding selected model Message is validated in the same transaction
// so a stale client can never continue a changed narrative position.
export function acceptConversationContinuationGeneration(
	database: Database,
	input: AcceptContinuationGenerationInput,
): AcceptedContinuationGeneration {
	const accept = database.transaction(() => {
		const db = connectConversationDatabase(database);
		ensureConversationRevision(db, input.conversationId, input.expectedRevision);
		if (input.humanParticipantId === input.modelParticipantId) {
			throw new InvalidConversationCommandError(
				"A Continuation Generation requires distinct human and model Participants.",
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

		const modelMessage = db
			.insert(messageTable)
			.values({
				chat_id: input.conversationId,
				position: latest.position + 1,
				timestamp: input.timestamp,
				author_participant_id: model.id,
				author_name: model.name,
				context_human_participant_id: human.id,
				context_model_participant_id: model.id,
			})
			.returning({ id: messageTable.id })
			.get();
		if (modelMessage === undefined) {
			throw new InvalidConversationCommandError(
				"The provisional model Message could not be persisted.",
			);
		}
		const provisional = db
			.insert(messageVariantTable)
			.values({
				message_id: modelMessage.id,
				position: 1,
				content: "",
				timestamp: input.timestamp,
				selected: true,
			})
			.returning({ id: messageVariantTable.id })
			.get();
		if (provisional === undefined) {
			throw new InvalidConversationCommandError(
				"The provisional model Variant could not be persisted.",
			);
		}
		const active = db
			.insert(activeGenerationTable)
			.values({
				chat_id: input.conversationId,
				human_message_id: null,
				message_id: modelMessage.id,
				variant_id: provisional.id,
				human_participant_id: human.id,
				model_participant_id: model.id,
				captured_human_name: input.capturedHumanName ?? human.name,
				captured_model_name: model.name,
				started_at: input.timestamp,
				prompt_plan_json: jsonText(input.promptPlan, "Prompt Plan"),
				prompt_inspection_json: jsonText(input.promptInspection ?? {}, "Prompt inspection"),
				history_roles_json: jsonText(input.historyRoles, "Prompt history roles"),
				generation_settings_json: jsonText(input.generationSettings, "Generation Settings"),
				connection_json: jsonText(input.connection, "Connection identity"),
				generation_intent_json: jsonText(
					input.generationIntent ?? { type: "continuation", strategy: "instruction" },
					"Generation intent",
				),
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
		const advanced = db
			.update(chatTable)
			.set({ revision: sql`${chatTable.revision} + 1`, last_message_time: input.timestamp })
			.where(
				and(
					eq(chatTable.id, input.conversationId),
					eq(chatTable.revision, input.expectedRevision),
				),
			)
			.returning({ revision: chatTable.revision })
			.get();
		if (advanced === undefined) {
			throw new StaleConversationRevisionError(
				input.expectedRevision,
				input.expectedRevision + 1,
			);
		}
		const conversation = readConversationSnapshot(db, input.conversationId);
		if (conversation === undefined) throw new ConversationNotFoundError(input.conversationId);
		return {
			generationId: active.id,
			modelMessageId: modelMessage.id,
			provisionalVariantId: provisional.id,
			conversation,
		};
	});
	return accept.immediate();
}

// Sibling acceptance is intentionally revision-neutral: several sibling
// attempts may reserve the same response position in parallel, and each
// reservation advances the Conversation revision independently. Tail and
// Continuation acceptance still reject every existing Active Generation.
export function acceptConversationSiblingGeneration(
	database: Database,
	input: AcceptSiblingGenerationInput,
): AcceptedSiblingGeneration {
	const accept = database.transaction(() => {
		const db = connectConversationDatabase(database);
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

		const prior = db
			.select({ id: messageVariantTable.id })
			.from(messageVariantTable)
			.where(
				and(
					eq(messageVariantTable.message_id, input.messageId),
					eq(messageVariantTable.selected, true),
				),
			)
			.get()?.id ?? null;
		const latestPosition = db
			.select({ value: max(messageVariantTable.position) })
			.from(messageVariantTable)
			.where(eq(messageVariantTable.message_id, input.messageId))
			.get()?.value;
		db.update(messageVariantTable)
			.set({ selected: false })
			.where(eq(messageVariantTable.message_id, input.messageId))
			.run();
		const provisional = db
			.insert(messageVariantTable)
			.values({
				message_id: input.messageId,
				position: (latestPosition ?? 0) + 1,
				content: "",
				timestamp: input.timestamp,
				selected: true,
			})
			.returning({ id: messageVariantTable.id })
			.get();
		if (provisional === undefined) {
			throw new InvalidConversationCommandError("The provisional sibling Variant could not be persisted.");
		}
		const active = db
			.insert(activeGenerationTable)
			.values({
				chat_id: input.conversationId,
				human_message_id: null,
				message_id: input.messageId,
				variant_id: provisional.id,
				prior_variant_id: prior,
				human_participant_id: input.humanParticipantId,
				model_participant_id: input.modelParticipantId,
				captured_human_name: input.capturedHumanName ?? human.name,
				captured_model_name: input.capturedModelName,
				started_at: input.timestamp,
				prompt_plan_json: jsonText(input.promptPlan, "Prompt Plan"),
				prompt_inspection_json: jsonText(input.promptInspection ?? {}, "Prompt inspection"),
				history_roles_json: jsonText(input.historyRoles, "Prompt history roles"),
				generation_settings_json: jsonText(input.generationSettings, "Generation Settings"),
				connection_json: jsonText(input.connection, "Connection identity"),
				generation_intent_json: jsonText(input.generationIntent ?? { type: "sibling" }, "Generation intent"),
				provenance_namespace: input.provenance?.namespace ?? null,
				provenance_key: input.provenance?.key ?? null,
				provenance_value: input.provenance?.value ?? null,
			})
			.returning({ id: activeGenerationTable.id })
			.get();
		if (active === undefined) {
			throw new InvalidConversationCommandError("The Active Generation could not be persisted.");
		}
		db.update(chatTable)
			.set({ revision: sql`${chatTable.revision} + 1`, last_message_time: input.timestamp })
			.where(eq(chatTable.id, input.conversationId))
			.run();
		const snapshot = readConversationSnapshot(db, input.conversationId);
		if (snapshot === undefined) throw new ConversationNotFoundError(input.conversationId);
		return {
			generationId: active.id,
			messageId: input.messageId,
			provisionalVariantId: provisional.id,
			priorVariantId: prior,
			conversation: snapshot,
		};
	});
	return accept.immediate();
}

// Resolving a sibling keeps the target Message and its original Author Stamp
// intact; only the accepted provisional Variant becomes durable.
export function resolveConversationSiblingGeneration(
	database: Database,
	input: ResolveSiblingGenerationInput,
): ConversationSnapshot {
	const resolve = database.transaction(() => {
		const db = connectConversationDatabase(database);
		const active = readActiveGeneration(db, input.conversationId, input.generationId);
		if (active === undefined || !isSiblingGenerationRow(active)) {
			throw new InvalidConversationCommandError("The Sibling Generation is no longer available.");
		}
		const variant = db
			.select({ id: messageVariantTable.id })
			.from(messageVariantTable)
			.where(
				and(
					eq(messageVariantTable.id, active.variant_id),
					eq(messageVariantTable.message_id, active.message_id),
				),
			)
			.get();
		if (variant === undefined) {
			throw new InvalidConversationCommandError("The provisional sibling Variant is no longer available.");
		}
		db.update(messageVariantTable)
			.set({ content: input.content, timestamp: input.timestamp })
			.where(eq(messageVariantTable.id, variant.id))
			.run();
		const suppliedData = input.data ?? [];
		const provenance = terminalProvenance(active, suppliedData);
		const data = [
			...(provenance === undefined ? [] : [provenance]),
			...(input.reasoning !== undefined && input.reasoning.length > 0 &&
				!suppliedData.some((entry) => entry.namespace === "generation" && entry.key === "reasoning")
				? [{ namespace: "generation", key: "reasoning", value: input.reasoning }]
				: []),
			...suppliedData,
		];
		if (data.length > 0) {
			db.insert(messageVariantDataTable)
				.values(data.map((entry) => ({
					message_variant_id: variant.id,
					namespace: entry.namespace,
					key: entry.key,
					value: entry.value,
				})))
				.run();
		}
		db.delete(activeGenerationTable)
			.where(eq(activeGenerationTable.id, active.id))
			.run();
		db.update(chatTable)
			.set({ revision: sql`${chatTable.revision} + 1`, last_message_time: input.timestamp })
			.where(eq(chatTable.id, input.conversationId))
			.run();
		const snapshot = readConversationSnapshot(db, input.conversationId);
		if (snapshot === undefined) throw new ConversationNotFoundError(input.conversationId);
		return snapshot;
	});
	return resolve.immediate();
}

// An empty sibling failure removes only its provisional Variant. If that
// Variant is still selected, restore the selection visible at acceptance;
// an explicit selection made while it ran remains authoritative.
export function removeConversationSiblingGeneration(
	database: Database,
	input: RemoveSiblingGenerationInput,
): ConversationSnapshot {
	const remove = database.transaction(() => {
		const db = connectConversationDatabase(database);
		const active = readActiveGeneration(db, input.conversationId, input.generationId);
		if (active === undefined || !isSiblingGenerationRow(active)) {
			throw new InvalidConversationCommandError("The Sibling Generation is no longer available.");
		}
		const variant = db
			.select({ id: messageVariantTable.id, selected: messageVariantTable.selected })
			.from(messageVariantTable)
			.where(
				and(
					eq(messageVariantTable.id, active.variant_id),
					eq(messageVariantTable.message_id, active.message_id),
				),
			)
			.get();
		if (variant === undefined) {
			throw new InvalidConversationCommandError("The provisional sibling Variant is no longer available.");
		}
		db.delete(activeGenerationTable)
			.where(eq(activeGenerationTable.id, active.id))
			.run();
		db.delete(messageVariantTable)
			.where(eq(messageVariantTable.id, variant.id))
			.run();
		if (variant.selected && active.prior_variant_id !== null) {
			db.update(messageVariantTable)
				.set({ selected: true })
				.where(
					and(
						eq(messageVariantTable.id, active.prior_variant_id),
						eq(messageVariantTable.message_id, active.message_id),
					),
				)
				.run();
		}
		db.update(chatTable)
			.set({ revision: sql`${chatTable.revision} + 1` })
			.where(eq(chatTable.id, input.conversationId))
			.run();
		const snapshot = readConversationSnapshot(db, input.conversationId);
		if (snapshot === undefined) throw new ConversationNotFoundError(input.conversationId);
		return snapshot;
	});
	return remove.immediate();
}

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

// Resolving replaces the provisional content and writes compact terminal
// provenance before removing the Active Generation record. It advances the
// Conversation revision exactly once as a lifecycle transition.
export function resolveConversationTailGeneration(
	database: Database,
	input: ResolveTailGenerationInput,
): ConversationSnapshot {
	const resolve = database.transaction(() => {
		const db = connectConversationDatabase(database);
		const active = readActiveGeneration(db, input.conversationId, input.generationId);
		if (active === undefined) {
			throw new InvalidConversationCommandError("The Active Generation is no longer available.");
		}
		const variant = db
			.select({ id: messageVariantTable.id })
			.from(messageVariantTable)
			.where(
				and(
					eq(messageVariantTable.id, active.variant_id),
					eq(messageVariantTable.message_id, active.message_id),
				),
			)
			.get();
		if (variant === undefined) {
			throw new InvalidConversationCommandError("The provisional Variant is no longer available.");
		}
		db.update(messageVariantTable)
			.set({ content: input.content, timestamp: input.timestamp })
			.where(eq(messageVariantTable.id, variant.id))
			.run();
		const suppliedData = input.data ?? [];
		const provenance = terminalProvenance(active, suppliedData);
		const data = [
			...(provenance === undefined ? [] : [provenance]),
			...(input.reasoning !== undefined && input.reasoning.length > 0 &&
				!suppliedData.some((entry) => entry.namespace === "generation" && entry.key === "reasoning")
				? [{ namespace: "generation", key: "reasoning", value: input.reasoning }]
				: []),
			...suppliedData,
		];
		if (data.length > 0) {
			db.insert(messageVariantDataTable)
				.values(data.map((entry) => ({
					message_variant_id: variant.id,
					namespace: entry.namespace,
					key: entry.key,
					value: entry.value,
				})))
				.run();
		}
		db.delete(activeGenerationTable)
			.where(eq(activeGenerationTable.id, active.id))
			.run();
		db.update(chatTable)
			.set({ revision: sql`${chatTable.revision} + 1`, last_message_time: input.timestamp })
			.where(eq(chatTable.id, input.conversationId))
			.run();
		const snapshot = readConversationSnapshot(db, input.conversationId);
		if (snapshot === undefined) throw new ConversationNotFoundError(input.conversationId);
		return snapshot;
	});
	return resolve.immediate();
}

// Checkpointing a Provisional Variant is deliberately revision-neutral. The
// Active Generation already owns the accepted lifecycle transition; streaming
// output is mutable execution state and must not make unrelated Conversation
// commands conflict with one another.
export function checkpointConversationTailGeneration(
	database: Database,
	input: {
		conversationId: number;
		generationId: number;
		content: string;
		reasoning?: string;
		latestEventId?: number;
		timestamp?: string;
	},
): void {
	checkpointConversationGeneration(database, input);
}

// Sibling checkpoints share the same revision-neutral semantics as Tail
// checkpoints. The target is selected by the Active Generation id, never by
// a client-supplied Variant id.
export function checkpointConversationSiblingGeneration(
	database: Database,
	input: {
		conversationId: number;
		generationId: number;
		content: string;
		reasoning?: string;
		latestEventId?: number;
		timestamp?: string;
	},
): void {
	const db = connectConversationDatabase(database);
	const active = readActiveGeneration(db, input.conversationId, input.generationId);
	if (active === undefined || !isSiblingGenerationRow(active)) return;
	checkpointConversationGeneration(database, input);
}

/**
 * Persist one revision-neutral Generation checkpoint.
 *
 * The Active Generation row is the authoritative crash-recovery copy of both
 * streams and their application event position. The provisional Variant's
 * visible content is mirrored as well so a normal Conversation read remains
 * useful while the provider is still running. Reasoning stays active-only
 * until terminal resolution, keeping ordinary history free of partial private
 * reasoning.
 */
export function checkpointConversationGeneration(
	database: Database,
	input: {
		conversationId: number;
		generationId: number;
		content: string;
		reasoning?: string;
		latestEventId?: number;
		timestamp?: string;
	},
): void {
	const checkpoint = database.transaction(() => {
		const db = connectConversationDatabase(database);
		const active = readActiveGeneration(db, input.conversationId, input.generationId);
		if (active === undefined) return;
		const currentEventId = active.checkpoint_event_id;
		if (
			input.latestEventId !== undefined &&
			Number.isInteger(input.latestEventId) &&
			input.latestEventId < currentEventId
		) return;
		const eventId = input.latestEventId === undefined || !Number.isInteger(input.latestEventId)
			? currentEventId
			: Math.max(currentEventId, input.latestEventId);
		const values: CheckpointVariantValues = { content: input.content };
		if (input.timestamp !== undefined) values.timestamp = input.timestamp;
		db.update(messageVariantTable)
			.set(values)
			.where(
				and(
					eq(messageVariantTable.id, active.variant_id),
					eq(messageVariantTable.message_id, active.message_id),
				),
			)
			.run();
		db.update(activeGenerationTable)
			.set({
				checkpoint_content: input.content,
				checkpoint_reasoning: input.reasoning ?? active.checkpoint_reasoning,
				checkpoint_event_id: eventId,
				checkpointed_at: input.timestamp ?? new Date().toISOString(),
			})
			.where(
				and(
					eq(activeGenerationTable.id, active.id),
					eq(activeGenerationTable.chat_id, input.conversationId),
				),
			)
			.run();
	});
	checkpoint.immediate();
}

// A zero-output failure removes only the provisional model Message and its
// Active Generation. The accepted human Message remains the latest authored
// writing, ready for an identical Send to reuse it without duplication.
export function removeConversationTailGeneration(
	database: Database,
	input: RemoveTailGenerationInput,
): ConversationSnapshot {
	const remove = database.transaction(() => {
		const db = connectConversationDatabase(database);
		const active = readActiveGeneration(db, input.conversationId, input.generationId);
		if (active === undefined) {
			throw new InvalidConversationCommandError("The Active Generation is no longer available.");
		}
		db.delete(activeGenerationTable)
			.where(eq(activeGenerationTable.id, active.id))
			.run();
		db.delete(messageTable)
			.where(
				and(
					eq(messageTable.id, active.message_id),
					eq(messageTable.chat_id, input.conversationId),
				),
			)
			.run();
		db.update(chatTable)
			.set({ revision: sql`${chatTable.revision} + 1` })
			.where(eq(chatTable.id, input.conversationId))
			.run();
		const snapshot = readConversationSnapshot(db, input.conversationId);
		if (snapshot === undefined) throw new ConversationNotFoundError(input.conversationId);
		return snapshot;
	});
	return remove.immediate();
}

// Explicit Stop uses the latest durable checkpoint as its terminal input. A
// live runtime flushes immediately before calling this seam; a caller without
// a runtime still gets the last authoritative checkpoint and the same cleanup
// rules. The existing resolve/remove operations keep the transition atomic,
// and a race with a provider terminal event simply reports that the target is
// no longer available to the losing caller.
export function stopConversationGeneration(
	database: Database,
	input: StopGenerationInput,
): ConversationSnapshot {
	const db = connectConversationDatabase(database);
	const active = readActiveGeneration(db, input.conversationId, input.generationId);
	if (active === undefined) {
		throw new InvalidConversationCommandError("The Active Generation is no longer available.");
	}
	const timestamp = input.timestamp ?? new Date().toISOString();
	const content = active.checkpoint_content;
	const reasoning = active.checkpoint_reasoning;
	if (content.length === 0 && reasoning.length === 0) {
		if (isSiblingGenerationRow(active)) {
			return removeConversationSiblingGeneration(database, {
				conversationId: input.conversationId,
				generationId: input.generationId,
			});
		}
		return removeConversationTailGeneration(database, {
			conversationId: input.conversationId,
			generationId: input.generationId,
		});
	}

	const data = [
		{ namespace: "generation", key: "outcome", value: "interrupted" },
		{ namespace: "generation", key: "interruption-cause", value: "user-stop" },
	] satisfies ConversationDataEntry[];
	if (isSiblingGenerationRow(active)) {
		return resolveConversationSiblingGeneration(database, {
			conversationId: input.conversationId,
			generationId: input.generationId,
			timestamp,
			content,
			reasoning,
			data,
		});
	}
	return resolveConversationTailGeneration(database, {
		conversationId: input.conversationId,
		generationId: input.generationId,
		timestamp,
		content,
		reasoning,
		data,
	});
}
