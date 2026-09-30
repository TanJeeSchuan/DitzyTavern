// ==[HUMAN APPROVED]== Deliberate Generation detail reads. These are kept out of the ordinary
// Conversation snapshot/history paths so active prompt text is retained only
// for the bounded server-owned lifecycle and terminal reads expose only the
// compact safe provenance allow-list.

import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import { and, eq, inArray } from "drizzle-orm";
import {
	activeGenerationTable,
	conversationTable,
	generationReplayTable,
	messageTable,
	messageVariantDataTable,
	messageVariantTable,
	participantTable,
} from "../database/schema";
import { LORE_ACTIVATION_KEY, LORE_ACTIVATION_NAMESPACE, parseLoreActivationRecord } from "../../shared/contract/lore-activation";
import {
	MEMORY_ACTIVATION_KEY,
	MEMORY_ACTIVATION_NAMESPACE,
	isMemoryActivationRecord,
	MemoryActivationRecordParseError,
	parseMemoryActivationRecord,
} from "../../shared/contract/memory-recall";
import {
	connectConversationDatabase,
	readActiveCast,
	type ConversationDatabase,
} from "./internal";
import {
	toAuthorStamp,
	toHistoricalContext,
} from "./message-read-projection";
import type {
	ActiveGenerationDetails,
	ConversationJsonValue,
	GenerationProvenance,
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
import {
	promptPlan,
	type PromptPlan,
} from "../../shared/contract/conversation-schema";

interface SafeConnection {
	readonly [key: string]: ConversationJsonValue;
	profileId: number | null;
	settingsRevision: number | null;
	backend: string | null;
	adapter: string | null;
	apiFormat: string | null;
}

const safeConnection = (value: ConversationJsonValue): SafeConnection => {
	const source = generationJsonObject(value);
	return {
		profileId: generationJsonInteger(source?.profileId),
		settingsRevision: generationJsonInteger(source?.settingsRevision),
		backend: generationJsonString(source?.backend),
		adapter: generationJsonString(source?.adapter),
		apiFormat: generationJsonString(source?.apiFormat),
	};
};

// ==[HUMAN APPROVED]== Active inspection decodes the persisted Generation Settings into the safe
// display projection over the canonical Generation Settings vocabulary
// (ADR-0032). Every canonical field except Request Overrides participates —
// inspection never re-exposes Request Overrides — and every participating
// field decodes as null when the persisted value is absent or corrupt. The
// Safety allowance participates like every other budget field, so the
// formerly omitted value is retained instead of being decoded as absent.
type InspectionSettingsField = Exclude<GenerationSettingsField, "requestOverrides">;

// ==[HUMAN APPROVED]== The persisted value is written from validated domain settings, so display
// decoding keeps strings loose: a corrupt persisted value surfaces as its
// raw string rather than being silently mistaken for a valid literal.
type InspectionSettingsValue<T> = T extends string ? string | null : T | null;

type SafeGenerationSettings = {
	[K in InspectionSettingsField]: InspectionSettingsValue<CanonicalGenerationSettings[K]>;
};

// ==[HUMAN APPROVED]== The decoded value for each inspection field. Compile-locked: adding a
// canonical field (outside the exclusion) fails typecheck until inspection
// states how it decodes.
type InspectionSettingsDecoder = {
	readonly [K in InspectionSettingsField]: (
		source: Record<string, ConversationJsonValue> | null,
	) => InspectionSettingsValue<CanonicalGenerationSettings[K]>;
};

const inspectionSettingsFieldValue: InspectionSettingsDecoder = {
	modelId: (source) => generationJsonString(source?.modelId),
	temperature: (source) => generationJsonNumber(source?.temperature),
	topP: (source) => generationJsonNumber(source?.topP),
	frequencyPenalty: (source) => generationJsonNumber(source?.frequencyPenalty),
	presencePenalty: (source) => generationJsonNumber(source?.presencePenalty),
	contextLimit: (source) => generationJsonInteger(source?.contextLimit),
	responseBudget: (source) => generationJsonInteger(source?.responseBudget),
	safetyAllowance: (source) => generationJsonInteger(source?.safetyAllowance),
	siblingGenerationLimit: (source) => generationJsonInteger(source?.siblingGenerationLimit),
	continuationStrategy: (source) => generationJsonString(source?.continuationStrategy),
	continuationInstruction: (source) => generationJsonString(source?.continuationInstruction),
	continuationPrefillSuffix: (source) => generationJsonString(source?.continuationPrefillSuffix),
};

const safeGenerationSettings = (value: ConversationJsonValue): SafeGenerationSettings => {
	// ==[HUMAN APPROVED]== SAFETY: a non-object source decodes as an empty record, and every field
	// decoder then resolves its own intentional null.
	const source = generationJsonObject(value);
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

const deriveGenerationStatus = (
	active: boolean,
	terminalStatus: string | null | undefined,
): ActiveGenerationDetails["status"] =>
	active
		? "active"
		: terminalStatus === "length-limited" || terminalStatus === "interrupted"
			? terminalStatus
			: "complete";

const persistedPromptPlan = (value: string): PromptPlan => {
	const parsed = parseGenerationJson(value, null);
	if (!Value.Check(promptPlan, parsed)) {
		throw new Error("Persisted generation prompt plan is invalid.");
	}
	return parsed;
};

export function readActiveGenerationDetails(
	database: Database,
	conversationId: number,
	generationId: number,
): ActiveGenerationDetails | undefined {
	return readActiveGenerationDetailsFromConnection(
		connectConversationDatabase(database),
		conversationId,
		generationId,
	);
}

export function readActiveGenerationDetailsFromConnection(
	db: ConversationDatabase,
	conversationId: number,
	generationId: number,
): ActiveGenerationDetails | undefined {
	const active = db.select().from(activeGenerationTable).where(and(
		eq(activeGenerationTable.id, generationId),
		eq(activeGenerationTable.conversation_id, conversationId),
	)).get();
	const retained = active === undefined
		? db.select().from(generationReplayTable).where(and(
			eq(generationReplayTable.id, generationId),
			eq(generationReplayTable.conversation_id, conversationId),
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
	const conversation = db.select({ id: conversationTable.id }).from(conversationTable).where(eq(conversationTable.id, conversationId)).get();
	if (conversation === undefined) return undefined;
	const humanName = row.captured_human_name.length > 0
		? row.captured_human_name
		: db.select({ name: participantTable.name }).from(participantTable)
			.where(eq(participantTable.id, row.human_participant_id)).get()?.name ?? "";
	const inspection = parseGenerationJson(row.prompt_inspection_json, {});
	const inspectionRecord = generationJsonObject(inspection);
	const settings = safeGenerationSettings(parseGenerationJson(row.generation_settings_json, {}));
	const omittedContext = Array.isArray(inspectionRecord?.omittedContext) ? inspectionRecord.omittedContext : [];
	const loreActivation = parseLoreActivationRecord(row.lore_activation_json);
	const memoryActivationValue = inspectionRecord?.memoryActivation ?? null;
	if (memoryActivationValue !== null && !isMemoryActivationRecord(memoryActivationValue)) {
		throw new MemoryActivationRecordParseError("Persisted Memory Activation evidence is invalid.");
	}
	const memoryActivation = memoryActivationValue === null ? null : memoryActivationValue;
	return {
		conversationId,
		generationId: row.id,
		messageId: row.message_id,
		variantId: row.variant_id,
		startedAt: row.started_at,
		status: deriveGenerationStatus(active !== undefined, retained?.terminal_status),
		intent: parseGenerationJson(row.generation_intent_json, {}),
		participants: {
			human: { id: row.human_participant_id, name: humanName },
			model: { id: row.model_participant_id, name: row.captured_model_name },
		},
		promptPlan: persistedPromptPlan(row.prompt_plan_json),
		promptContext: parseGenerationJson(row.prompt_context_json, []),
		loreActivation,
		memoryActivation,
		memorySources: readMemorySourceAvailabilityFromConnection(db, conversationId, memoryActivation),
		generationSettings: settings,
		connection: safeConnection(parseGenerationJson(row.connection_json, null)),
		budget: {
			tokenEstimate: generationJsonInteger(inspectionRecord?.tokenEstimate),
			responseBudget: generationJsonInteger(inspectionRecord?.responseBudget) ?? generationJsonInteger(settings.responseBudget),
			safetyAllowance: generationJsonInteger(inspectionRecord?.safetyAllowance) ?? generationJsonInteger(settings.safetyAllowance),
			contextLimit: generationJsonInteger(inspectionRecord?.contextLimit) ?? generationJsonInteger(settings.contextLimit),
			totalRequiredTokens: generationJsonInteger(inspectionRecord?.totalRequiredTokens),
			omittedContext,
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
	database: Database,
	conversationId: number,
	messageId: number,
	variantId: number,
): VariantDetails | undefined {
	return readVariantDetailsFromConnection(
		connectConversationDatabase(database),
		conversationId,
		messageId,
		variantId,
	);
}

export function readVariantDetailsFromConnection(
	db: ConversationDatabase,
	conversationId: number,
	messageId: number,
	variantId: number,
): VariantDetails | undefined {
	const message = db.select().from(messageTable).where(and(
		eq(messageTable.id, messageId),
		eq(messageTable.conversation_id, conversationId),
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
	const loreActivationEntry = data.find((entry) => entry.namespace === LORE_ACTIVATION_NAMESPACE && entry.key === LORE_ACTIVATION_KEY);
	const memoryActivationEntry = data.find((entry) => entry.namespace === MEMORY_ACTIVATION_NAMESPACE && entry.key === MEMORY_ACTIVATION_KEY);
	let provenanceValue: ConversationJsonValue | null = null;
	if (provenanceEntry !== undefined) provenanceValue = parseGenerationJson(provenanceEntry.value, null);
	const loreActivation = loreActivationEntry === undefined
		? null
		: parseLoreActivationRecord(loreActivationEntry.value);
	const memoryActivation = memoryActivationEntry === undefined
		? null
		: parseMemoryActivationRecord(memoryActivationEntry.value);
	const castIds = message.author_participant_id === null
		? new Set<number>()
		: new Set(readActiveCast(db, conversationId).map((participant) => participant.id));
	return {
		conversationId,
		messageId,
		variantId,
		content: variant.content,
		timestamp: variant.timestamp,
		author: toAuthorStamp(message, castIds),
		historicalContext: toHistoricalContext(message),
		provenance: safeProvenance(provenanceValue, data),
		loreActivation,
		memoryActivation,
		memorySources: readMemorySourceAvailabilityFromConnection(db, conversationId, memoryActivation),
	};
}

const readMemorySourceAvailabilityFromConnection = (
	db: ConversationDatabase,
	conversationId: number,
	activation: ActiveGenerationDetails["memoryActivation"],
): ActiveGenerationDetails["memorySources"] => {
	const messageIds = [...new Set([...activation?.scanMessageIds ?? [], ...activation?.candidates.flatMap((candidate) => [candidate.messageId, ...candidate.evidence.map(({ messageId }) => messageId)]) ?? []])];
	const variantIds = [...new Set(activation?.candidates.map(({ variantId }) => variantId) ?? [])];
	return {
		messageIds: messageIds.length === 0 ? [] : db.select({ id: messageTable.id }).from(messageTable).where(and(eq(messageTable.conversation_id, conversationId), inArray(messageTable.id, messageIds))).all().map(({ id }) => id),
		variantIds: variantIds.length === 0 ? [] : db.select({ id: messageVariantTable.id }).from(messageVariantTable).innerJoin(messageTable, eq(messageTable.id, messageVariantTable.message_id)).where(and(eq(messageTable.conversation_id, conversationId), inArray(messageVariantTable.id, variantIds))).all().map(({ id }) => id),
	};
};

export const readMemorySourceAvailability = (
	database: Database,
	conversationId: number,
	activation: ActiveGenerationDetails["memoryActivation"],
): ActiveGenerationDetails["memorySources"] =>
	readMemorySourceAvailabilityFromConnection(connectConversationDatabase(database), conversationId, activation);
