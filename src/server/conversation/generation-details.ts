// Deliberate Generation detail reads. These are kept out of the ordinary
// Conversation snapshot/history paths so active prompt text is retained only
// for the bounded server-owned lifecycle and terminal reads expose only the
// compact safe provenance allow-list.

import { and, eq, isNull } from "drizzle-orm";
import {
	activeGenerationTable,
	chatTable,
	generationReplayTable,
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
import {
	generationProvenanceCodec,
	generationJsonInteger,
	generationJsonNumber,
	generationJsonObject,
	generationJsonString,
	parseGenerationJson,
} from "../../shared/generation-provenance";
import {
	type CanonicalGenerationSettings,
	type GenerationSettingsField,
} from "../../shared/contract/generation-settings";

const isRecord = generationJsonObject;
const parseJson = parseGenerationJson;
const finiteInteger = generationJsonInteger;
const finiteNumber = generationJsonNumber;
const nullableString = generationJsonString;

interface SafeConnection {
	readonly [key: string]: ConversationJsonValue;
	profileId: number | null;
	settingsRevision: number | null;
	backend: string | null;
	adapter: string | null;
	apiFormat: string | null;
}

const safeConnection = (value: ConversationJsonValue): SafeConnection => {
	const source = isRecord(value);
	return {
		profileId: finiteInteger(source?.profileId),
		settingsRevision: finiteInteger(source?.settingsRevision),
		backend: nullableString(source?.backend),
		adapter: nullableString(source?.adapter),
		apiFormat: nullableString(source?.apiFormat),
	};
};

// Active inspection decodes the persisted Generation Settings into the safe
// display projection over the canonical Generation Settings vocabulary
// (ADR-0032). Every canonical field except Request Overrides participates —
// inspection never re-exposes Request Overrides — and every participating
// field decodes as null when the persisted value is absent or corrupt. The
// Safety allowance participates like every other budget field, so the
// formerly omitted value is retained instead of being decoded as absent.
type InspectionSettingsField = Exclude<GenerationSettingsField, "requestOverrides">;

// The persisted value is written from validated domain settings, so display
// decoding keeps strings loose: a corrupt persisted value surfaces as its
// raw string rather than being silently mistaken for a valid literal.
type InspectionSettingsValue<T> = T extends string ? string | null : T | null;

type SafeGenerationSettings = {
	[K in InspectionSettingsField]: InspectionSettingsValue<CanonicalGenerationSettings[K]>;
};

// The decoded value for each inspection field. Compile-locked: adding a
// canonical field (outside the exclusion) fails typecheck until inspection
// states how it decodes.
type InspectionSettingsDecoder = {
	readonly [K in InspectionSettingsField]: (
		source: Record<string, ConversationJsonValue> | null,
	) => InspectionSettingsValue<CanonicalGenerationSettings[K]>;
};

const inspectionSettingsFieldValue: InspectionSettingsDecoder = {
	modelId: (source) => nullableString(source?.modelId),
	temperature: (source) => finiteNumber(source?.temperature),
	topP: (source) => finiteNumber(source?.topP),
	frequencyPenalty: (source) => finiteNumber(source?.frequencyPenalty),
	presencePenalty: (source) => finiteNumber(source?.presencePenalty),
	contextLimit: (source) => finiteInteger(source?.contextLimit),
	responseBudget: (source) => finiteInteger(source?.responseBudget),
	safetyAllowance: (source) => finiteInteger(source?.safetyAllowance),
	siblingGenerationLimit: (source) => finiteInteger(source?.siblingGenerationLimit),
	continuationStrategy: (source) => nullableString(source?.continuationStrategy),
	continuationInstruction: (source) => nullableString(source?.continuationInstruction),
	continuationPrefillSuffix: (source) => nullableString(source?.continuationPrefillSuffix),
};

const safeGenerationSettings = (value: ConversationJsonValue): SafeGenerationSettings => {
	// SAFETY: a non-object source decodes as an empty record, and every field
	// decoder then resolves its own intentional null.
	const source = isRecord(value);
	return {
		modelId: inspectionSettingsFieldValue.modelId(source),
		temperature: inspectionSettingsFieldValue.temperature(source),
		topP: inspectionSettingsFieldValue.topP(source),
		frequencyPenalty: inspectionSettingsFieldValue.frequencyPenalty(source),
		presencePenalty: inspectionSettingsFieldValue.presencePenalty(source),
		contextLimit: inspectionSettingsFieldValue.contextLimit(source),
		responseBudget: inspectionSettingsFieldValue.responseBudget(source),
		safetyAllowance: inspectionSettingsFieldValue.safetyAllowance(source),
		siblingGenerationLimit: inspectionSettingsFieldValue.siblingGenerationLimit(source),
		continuationStrategy: inspectionSettingsFieldValue.continuationStrategy(source),
		continuationInstruction: inspectionSettingsFieldValue.continuationInstruction(source),
		continuationPrefillSuffix: inspectionSettingsFieldValue.continuationPrefillSuffix(source),
	};
};

const safeProvenance = (
	value: ConversationJsonValue | null,
	data: readonly { namespace: string; key: string; value: string }[],
): GenerationProvenance | null => generationProvenanceCodec.decodeStored(value, data);

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
	const active = db.select().from(activeGenerationTable).where(and(
		eq(activeGenerationTable.id, generationId),
		eq(activeGenerationTable.chat_id, conversationId),
	)).get();
	const retained = active === undefined
		? db.select().from(generationReplayTable).where(and(
			eq(generationReplayTable.id, generationId),
			eq(generationReplayTable.chat_id, conversationId),
		)).get()
		: undefined;
	if (retained !== undefined && retained.expires_at <= new Date().toISOString()) {
		db.delete(generationReplayTable)
			.where(eq(generationReplayTable.id, retained.id))
			.run();
		return undefined;
	}
	const row = active ?? retained;
	if (row === undefined) return undefined;
	const conversation = db.select({ id: chatTable.id }).from(chatTable).where(eq(chatTable.id, conversationId)).get();
	if (conversation === undefined) return undefined;
	const humanName = row.captured_human_name.length > 0
		? row.captured_human_name
		: db.select({ name: participantTable.name }).from(participantTable)
			.where(eq(participantTable.id, row.human_participant_id)).get()?.name ?? "";
	const inspection = parseJson(row.prompt_inspection_json, {});
	const inspectionRecord = isRecord(inspection);
	const settings = safeGenerationSettings(parseJson(row.generation_settings_json, {}));
	const omittedHistory = Array.isArray(inspectionRecord?.omittedHistory) ? inspectionRecord.omittedHistory : [];
	return {
		conversationId,
		generationId: row.id,
		messageId: row.message_id,
		variantId: row.variant_id,
		startedAt: row.started_at,
		status: active === undefined
			? retained?.terminal_status === "length-limited" || retained?.terminal_status === "interrupted"
				? retained.terminal_status
				: "complete"
			: "active",
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
			tokenEstimate: finiteInteger(inspectionRecord?.tokenEstimate),
			responseBudget: finiteInteger(inspectionRecord?.responseBudget) ?? finiteInteger(settings.responseBudget),
			safetyAllowance: finiteInteger(inspectionRecord?.safetyAllowance) ?? finiteInteger(settings.safetyAllowance),
			contextLimit: finiteInteger(inspectionRecord?.contextLimit) ?? finiteInteger(settings.contextLimit),
			totalRequiredTokens: finiteInteger(inspectionRecord?.totalRequiredTokens),
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
