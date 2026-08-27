// Deliberate Generation detail reads. These are kept out of the ordinary
// Conversation snapshot/history paths so active prompt text is retained only
// for the bounded server-owned lifecycle and terminal reads expose only the
// compact safe provenance allow-list.

import { and, eq, isNull } from "drizzle-orm";
import {
	activeGenerationTable,
	chatTable,
	messageTable,
	messageVariantDataTable,
	messageVariantTable,
	participantTable,
} from "../database/schema";
import type { ConversationDatabase } from "./internal";
import type {
	ActiveGenerationDetails,
	AuthorStampSnapshot,
	ConversationJsonValue,
	GenerationProvenance,
	HistoricalControlSnapshot,
	VariantDetails,
} from "./types";

type JsonRecord = { [key: string]: ConversationJsonValue };

const isRecord = (value: ConversationJsonValue | undefined): value is JsonRecord => {
	if (Object.prototype.toString.call(value) !== "[object Object]") return false;
	return true;
};

const parseJson = (value: string, fallback: ConversationJsonValue): ConversationJsonValue => {
	try {
		// SAFETY: JSON.parse returns only JSON-compatible scalars, arrays, and
		// objects; the fallback handles malformed or non-JSON input.
		return JSON.parse(value) as ConversationJsonValue;
	} catch {
		return fallback;
	}
};

const finiteInteger = (value: ConversationJsonValue | undefined): number | null => {
	if (Object.prototype.toString.call(value) !== "[object Number]") return null;
	const number = Number(value);
	return Number.isInteger(number) && Number.isFinite(number) ? number : null;
};

const finiteNumber = (value: ConversationJsonValue | undefined): number | null => {
	if (Object.prototype.toString.call(value) !== "[object Number]") return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
};

const nullableString = (value: ConversationJsonValue | undefined): string | null =>
	Object.prototype.toString.call(value) === "[object String]" ? String(value) : null;

interface SafeConnection {
	readonly [key: string]: ConversationJsonValue;
	profileId: number | null;
	settingsRevision: number | null;
	backend: string | null;
	adapter: string | null;
}

const safeConnection = (value: ConversationJsonValue): SafeConnection => {
	const source = isRecord(value) ? value : {};
	return {
		profileId: finiteInteger(source.profileId),
		settingsRevision: finiteInteger(source.settingsRevision),
		backend: nullableString(source.backend),
		adapter: nullableString(source.adapter),
	};
};

interface SafeGenerationSettings {
	readonly [key: string]: ConversationJsonValue;
	modelId: string | null;
	temperature: number | null;
	topP: number | null;
	frequencyPenalty: number | null;
	presencePenalty: number | null;
	contextLimit: number | null;
	responseBudget: number | null;
	safetyAllowance: number | null;
	siblingGenerationLimit: number | null;
	continuationStrategy: string | null;
	continuationInstruction: string | null;
	continuationPrefillSuffix: string | null;
}

const safeGenerationSettings = (value: ConversationJsonValue): SafeGenerationSettings => {
	const source = isRecord(value) ? value : {};
	return {
		modelId: nullableString(source.modelId),
		temperature: finiteNumber(source.temperature),
		topP: finiteNumber(source.topP),
		frequencyPenalty: finiteNumber(source.frequencyPenalty),
		presencePenalty: finiteNumber(source.presencePenalty),
		contextLimit: finiteInteger(source.contextLimit),
		responseBudget: finiteInteger(source.responseBudget),
		safetyAllowance: finiteInteger(source.safetyAllowance),
		siblingGenerationLimit: finiteInteger(source.siblingGenerationLimit),
		continuationStrategy: nullableString(source.continuationStrategy),
		continuationInstruction: nullableString(source.continuationInstruction),
		continuationPrefillSuffix: nullableString(source.continuationPrefillSuffix),
	};
};

interface SafeUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

const safeUsage = (value: ConversationJsonValue | undefined): SafeUsage | null => {
	if (!isRecord(value)) return null;
	const usage: SafeUsage = {};
	for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
		const number = finiteNumber(value[key]);
		if (number !== null && number >= 0) usage[key] = number;
	}
	return Object.keys(usage).length === 0 ? null : usage;
};

const safeStatus = (value: ConversationJsonValue | undefined): GenerationProvenance["status"] | null =>
	value === "complete" || value === "length-limited" || value === "interrupted"
		? value
		: null;

const safeFinishReason = (value: ConversationJsonValue | undefined): GenerationProvenance["finishReason"] =>
	value === "stop" || value === "length" || value === "other" ? value : null;

const safeProvenance = (
	value: ConversationJsonValue | null,
	data: readonly { namespace: string; key: string; value: string }[],
): GenerationProvenance | null => {
	const sourceValue = value ?? undefined;
	const source: JsonRecord = isRecord(sourceValue) ? sourceValue : {};
	const outcome = data.find((entry) => entry.namespace === "generation" && entry.key === "outcome")?.value;
	const interruptionCause = data.find(
		(entry) => entry.namespace === "generation" && entry.key === "interruption-cause",
	)?.value ?? null;
	const usageEntry = data.find((entry) => entry.namespace === "generation" && entry.key === "usage");
	const finishEntry = data.find((entry) => entry.namespace === "generation" && entry.key === "finish");
	let parsedUsage: ConversationJsonValue = source.usage;
	if (usageEntry !== undefined) {
		parsedUsage = parseJson(usageEntry.value, null);
	}
	let parsedFinish: JsonRecord = isRecord(source.finish) ? source.finish : {};
	if (finishEntry !== undefined) {
		const candidate = parseJson(finishEntry.value, null);
		if (isRecord(candidate)) parsedFinish = candidate;
	}
	const status = safeStatus(source.status) ?? safeStatus(outcome) ?? "complete";
	const hasProvenance = Object.keys(source).length > 0 || outcome !== undefined || usageEntry !== undefined || finishEntry !== undefined;
	if (!hasProvenance) return null;
	const settings = safeGenerationSettings(source.generationSettings);
	return {
		connectionProfileId: finiteInteger(source.connectionProfileId),
		connectionSettingsRevision: finiteInteger(source.connectionSettingsRevision),
		modelBackend: nullableString(source.modelBackend),
		adapter: nullableString(source.adapter),
		modelId: nullableString(source.modelId),
		generationSettings: {
			temperature: finiteNumber(settings.temperature),
			topP: finiteNumber(settings.topP),
			frequencyPenalty: finiteNumber(settings.frequencyPenalty),
			presencePenalty: finiteNumber(settings.presencePenalty),
			contextLimit: finiteInteger(settings.contextLimit),
			responseBudget: finiteInteger(settings.responseBudget),
			safetyAllowance: finiteInteger(settings.safetyAllowance),
			siblingGenerationLimit: finiteInteger(settings.siblingGenerationLimit),
			continuationStrategy: settings.continuationStrategy === "instruction" || settings.continuationStrategy === "assistant-prefill"
				? settings.continuationStrategy
				: null,
			continuationInstruction: nullableString(settings.continuationInstruction),
			continuationPrefillSuffix: settings.continuationPrefillSuffix === "" || settings.continuationPrefillSuffix === " " || settings.continuationPrefillSuffix === "\n" || settings.continuationPrefillSuffix === "\n\n"
				? settings.continuationPrefillSuffix
				: null,
		},
		usage: safeUsage(parsedUsage),
		finishReason: safeFinishReason(source.finishReason) ?? safeFinishReason(parsedFinish.reason),
		status,
		interruptionCause: nullableString(source.interruptionCause) ?? interruptionCause,
	};
};

const authorFor = (
	db: ConversationDatabase,
	conversationId: number,
	participantId: number | null,
	name: string | null,
): AuthorStampSnapshot | null => {
	if (participantId === null && name === null) return null;
	const active = participantId === null
		? undefined
		: db.select({ id: participantTable.id })
			.from(participantTable)
			.where(and(
				eq(participantTable.id, participantId),
				eq(participantTable.chat_id, conversationId),
				isNull(participantTable.deleted_at),
			)).get();
	return {
		participantId,
		capturedName: name,
		inCast: active !== undefined,
	};
};

const historicalContextFor = (message: {
	context_human_participant_id: number | null;
	context_model_participant_id: number | null;
}): HistoricalControlSnapshot | null =>
	message.context_human_participant_id !== null && message.context_model_participant_id !== null
		? {
			humanParticipantId: message.context_human_participant_id,
			modelParticipantId: message.context_model_participant_id,
		}
		: null;

export function readActiveGenerationDetails(
	db: ConversationDatabase,
	conversationId: number,
	generationId: number,
): ActiveGenerationDetails | undefined {
	const row = db.select().from(activeGenerationTable).where(and(
		eq(activeGenerationTable.id, generationId),
		eq(activeGenerationTable.chat_id, conversationId),
	)).get();
	if (row === undefined) return undefined;
	const conversation = db.select({ id: chatTable.id }).from(chatTable).where(eq(chatTable.id, conversationId)).get();
	if (conversation === undefined) return undefined;
	const humanName = row.captured_human_name.length > 0
		? row.captured_human_name
		: db.select({ name: participantTable.name }).from(participantTable)
			.where(eq(participantTable.id, row.human_participant_id)).get()?.name ?? "";
	const inspection = parseJson(row.prompt_inspection_json, {});
	const inspectionRecord = isRecord(inspection) ? inspection : {};
	const settings = safeGenerationSettings(parseJson(row.generation_settings_json, {}));
	const omittedHistory = Array.isArray(inspectionRecord.omittedHistory) ? inspectionRecord.omittedHistory : [];
	return {
		conversationId,
		generationId: row.id,
		messageId: row.message_id,
		variantId: row.variant_id,
		startedAt: row.started_at,
		status: "active",
		intent: parseJson(row.generation_intent_json, {}),
		participants: {
			human: { id: row.human_participant_id, name: humanName },
			model: { id: row.model_participant_id, name: row.captured_model_name },
		},
		promptPlan: parseJson(row.prompt_plan_json, {}),
		historyRoles: parseJson(row.history_roles_json, []),
		generationSettings: settings,
		connection: safeConnection(parseJson(row.connection_json, null)),
		budget: {
			tokenEstimate: finiteInteger(inspectionRecord.tokenEstimate),
		responseBudget: finiteInteger(inspectionRecord.responseBudget) ?? finiteInteger(settings.responseBudget),
		safetyAllowance: finiteInteger(inspectionRecord.safetyAllowance) ?? finiteInteger(settings.safetyAllowance),
		contextLimit: finiteInteger(inspectionRecord.contextLimit) ?? finiteInteger(settings.contextLimit),
			totalRequiredTokens: finiteInteger(inspectionRecord.totalRequiredTokens),
			omittedHistory,
		},
		checkpoint: {
			content: row.checkpoint_content,
			reasoning: row.checkpoint_reasoning,
			latestEventId: row.checkpoint_event_id,
			checkpointedAt: row.checkpointed_at,
		},
	};
}

export function readVariantDetails(
	db: ConversationDatabase,
	conversationId: number,
	messageId: number,
	variantId: number,
): VariantDetails | undefined {
	const message = db.select().from(messageTable).where(and(
		eq(messageTable.id, messageId),
		eq(messageTable.chat_id, conversationId),
	)).get();
	if (message === undefined) return undefined;
	const variant = db.select().from(messageVariantTable).where(and(
		eq(messageVariantTable.id, variantId),
		eq(messageVariantTable.message_id, messageId),
	)).get();
	if (variant === undefined) return undefined;
	const data = db.select({ namespace: messageVariantDataTable.namespace, key: messageVariantDataTable.key, value: messageVariantDataTable.value })
		.from(messageVariantDataTable)
		.where(eq(messageVariantDataTable.message_variant_id, variantId))
		.all();
	const provenanceEntry = data.find((entry) => entry.namespace === "generation" && entry.key === "provenance");
	let provenanceValue: ConversationJsonValue | null = null;
	if (provenanceEntry !== undefined) provenanceValue = parseJson(provenanceEntry.value, null);
	return {
		conversationId,
		messageId,
		variantId,
		content: variant.content,
		timestamp: variant.timestamp,
		author: authorFor(db, conversationId, message.author_participant_id, message.author_name),
		historicalContext: historicalContextFor(message),
		provenance: safeProvenance(provenanceValue, data),
	};
}
