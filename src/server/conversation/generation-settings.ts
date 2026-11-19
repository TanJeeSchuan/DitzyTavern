import { TransformDecodeCheckError, Value } from "@sinclair/typebox/value";
import type { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
import { conversationGenerationSettingsTable } from "../database/schema";
import {
	connectConversationDatabase,
	findConversation,
	type ConversationDatabase,
} from "./internal";
import { InvalidConversationCommandError } from "./errors";
import {
	canonicalGenerationSettings,
	isRepeatedImagePlacement,
	type CanonicalGenerationSettings,
	type GenerationSettingsField,
} from "../../shared/contract/generation-settings";
import type {
	ConversationGenerationSettings,
	ConversationGenerationSettingsInput,
	ContinuationPrefillSuffix,
} from "./types";

// @approved
//  The domain default derives from the canonical Generation Settings
// declaration: adding a canonical field fails typecheck until the default
// states its value, so the stored settings cannot silently omit a field.
export const DEFAULT_CONVERSATION_GENERATION_SETTINGS: ConversationGenerationSettings = {
	connectionProfileId: null,
	modelId: "deepseek-chat",
	temperature: null,
	topP: null,
	frequencyPenalty: null,
	presencePenalty: null,
	contextLimit: 32768,
	responseBudget: 1024,
	safetyAllowance: 500,
	siblingGenerationLimit: 4,
	continuationStrategy: "instruction",
	continuationInstruction: "Continue the narrative naturally without repeating the previous text.",
	continuationPrefillSuffix: "",
	repeatedImagePlacement: "first",
	requestOverrides: { "chat-completions": {}, responses: {}, "anthropic-messages": {} },
};

type SettingsRow = typeof conversationGenerationSettingsTable.$inferSelect;
const missingGenerationSettings = (conversationId: number) => new Error(`Conversation ${conversationId} is missing Generation Settings.`);

export function insertConversationGenerationSettings(
	db: ConversationDatabase,
	conversationId: number,
	{ connectionProfileId, ...settings }: ConversationGenerationSettings,
): void {
	db.insert(conversationGenerationSettingsTable)
		.values({ conversation_id: conversationId, connection_profile_id: connectionProfileId, settings_json: JSON.stringify(settings) })
		.run();
}

export function readConversationGenerationSettings(
	database: Database,
	conversationId: number,
): ConversationGenerationSettings | undefined {
	const db = connectConversationDatabase(database);
	if (findConversation(db, conversationId) === undefined) return undefined;
	return readConversationGenerationSettingsFromConnection(db, conversationId);
}

export function readConversationGenerationSettingsFromConnection(
	db: ConversationDatabase,
	conversationId: number,
): ConversationGenerationSettings | undefined {
	const row = db
		.select()
		.from(conversationGenerationSettingsTable)
		.where(eq(conversationGenerationSettingsTable.conversation_id, conversationId))
		.get();
	return row === undefined ? undefined : readGenerationSettingsRow(row);
}

export function requireConversationGenerationSettings(db: ConversationDatabase, conversationId: number): ConversationGenerationSettings {
	const settings = readConversationGenerationSettingsFromConnection(db, conversationId);
	if (settings === undefined) throw missingGenerationSettings(conversationId);
	return settings;
}

export function updateConversationGenerationSettings(
	db: ConversationDatabase,
	conversationId: number,
	input: ConversationGenerationSettingsInput,
): ConversationGenerationSettings {
	const normalized = normalizeGenerationSettings(input);
	const updated = db
		.update(conversationGenerationSettingsTable)
		.set({ settings_json: JSON.stringify(normalized) })
		.where(eq(conversationGenerationSettingsTable.conversation_id, conversationId))
		.returning()
		.get();
	if (updated === undefined) throw missingGenerationSettings(conversationId);
	return readGenerationSettingsRow(updated);
}

// @approved
//  Per-field normalization over the canonical vocabulary. Compile-locked:
// adding a canonical field fails typecheck until its normalization is
// stated, so validation cannot silently skip a field. Error messages and
// accepted values are the established domain semantics.
type SettingsFieldNormalizer = {
	readonly [K in GenerationSettingsField]: (
		value: CanonicalGenerationSettings[K],
	) => CanonicalGenerationSettings[K];
};

const normalizeSettingsField: SettingsFieldNormalizer = {
	modelId: (value) => {
		const modelId = value.trim();
		if (modelId.length === 0) {
			throw new InvalidConversationCommandError("A model ID is required.");
		}
		return modelId;
	},
	temperature: (value) => requireSampling("temperature", value),
	topP: (value) => requireSampling("topP", value),
	frequencyPenalty: (value) => requireSampling("frequencyPenalty", value),
	presencePenalty: (value) => requireSampling("presencePenalty", value),
	contextLimit: (value) => requirePositiveWholeNumber("Context limit", value),
	responseBudget: (value) => requirePositiveWholeNumber("Response budget", value),
	safetyAllowance: (value) => {
		if (!Number.isInteger(value) || value < 0) {
			throw new InvalidConversationCommandError(
				"Safety allowance must be a non-negative whole number.",
			);
		}
		return value;
	},
	siblingGenerationLimit: (value) =>
		requirePositiveWholeNumber("Sibling Generation limit", value),
	continuationStrategy: (value) => {
		if (value !== "instruction" && value !== "assistant-prefill") {
			throw new InvalidConversationCommandError(
				"Continuation strategy must be instruction or assistant prefill.",
			);
		}
		return value;
	},
	continuationInstruction: (value) => {
		if (value.trim() === "") {
			throw new InvalidConversationCommandError(
				"Continuation instruction must not be blank.",
			);
		}
		return value;
	},
	continuationPrefillSuffix: (value) => validateContinuationPrefillSuffix(value),
	repeatedImagePlacement: (value) => {
		if (!isRepeatedImagePlacement(value)) {
			throw new InvalidConversationCommandError("Repeated Image Placement must be first, last, or every.");
		}
		return value;
	},
	requestOverrides: (value) => cloneRequestOverrides(value),
};

const requireSampling = (label: string, value: number | null): number | null => {
	if (value !== null && (!Number.isFinite(value) || value < -2 || value > 2)) {
		throw new InvalidConversationCommandError(
			`${label} must be null or a finite value between -2 and 2.`,
		);
	}
	return value;
};

const requirePositiveWholeNumber = (label: string, value: number): number => {
	if (!Number.isInteger(value) || value <= 0) {
		throw new InvalidConversationCommandError(`${label} must be a positive whole number.`);
	}
	return value;
};

const normalizeGenerationSettings = (
	draft: CanonicalGenerationSettings,
): CanonicalGenerationSettings => ({
	modelId: normalizeSettingsField.modelId(draft.modelId),
	temperature: normalizeSettingsField.temperature(draft.temperature),
	topP: normalizeSettingsField.topP(draft.topP),
	frequencyPenalty: normalizeSettingsField.frequencyPenalty(draft.frequencyPenalty),
	presencePenalty: normalizeSettingsField.presencePenalty(draft.presencePenalty),
	contextLimit: normalizeSettingsField.contextLimit(draft.contextLimit),
	responseBudget: normalizeSettingsField.responseBudget(draft.responseBudget),
	safetyAllowance: normalizeSettingsField.safetyAllowance(draft.safetyAllowance),
	siblingGenerationLimit: normalizeSettingsField.siblingGenerationLimit(draft.siblingGenerationLimit),
	continuationStrategy: normalizeSettingsField.continuationStrategy(draft.continuationStrategy),
	continuationInstruction: normalizeSettingsField.continuationInstruction(draft.continuationInstruction),
	continuationPrefillSuffix: normalizeSettingsField.continuationPrefillSuffix(draft.continuationPrefillSuffix),
	repeatedImagePlacement: normalizeSettingsField.repeatedImagePlacement(draft.repeatedImagePlacement),
	requestOverrides: normalizeSettingsField.requestOverrides(draft.requestOverrides),
});

const readGenerationSettingsRow = (row: SettingsRow): ConversationGenerationSettings => {
	try {
		const settings = Value.Decode<typeof canonicalGenerationSettings>(canonicalGenerationSettings, JSON.parse(row.settings_json));
		return { ...settings, connectionProfileId: row.connection_profile_id };
	} catch (cause) {
		const reason = cause instanceof TransformDecodeCheckError && cause.error?.path.startsWith("/requestOverrides")
			? `Conversation ${row.conversation_id} Generation Request Overrides are corrupt.`
			: cause instanceof Error ? cause.message : "invalid stored row";
		throw new Error(`Conversation ${row.conversation_id} Generation Settings are corrupt: ${reason}`, { cause });
	}
};

export function updateConversationModelSelection(
	db: ConversationDatabase,
	conversationId: number,
	{ connectionProfileId, modelId }: Pick<ConversationGenerationSettings, "connectionProfileId" | "modelId">,
): void {
	const updated = db
		.update(conversationGenerationSettingsTable)
		.set({
			connection_profile_id: connectionProfileId,
			settings_json: sql`json_set(${conversationGenerationSettingsTable.settings_json}, '$.modelId', ${modelId})`,
		})
		.where(eq(conversationGenerationSettingsTable.conversation_id, conversationId))
		.run();
	if (updated.changes === 0) throw missingGenerationSettings(conversationId);
}

function validateContinuationPrefillSuffix(
	value: ContinuationPrefillSuffix,
): ContinuationPrefillSuffix {
	if (value === "" || value === " " || value === "\n" || value === "\n\n") return value;
	throw new InvalidConversationCommandError(
		"Continuation prefill suffix must be none, a space, a newline, or a double newline.",
	);
}

function cloneRequestOverrides(
	value: ConversationGenerationSettings["requestOverrides"],
): ConversationGenerationSettings["requestOverrides"] {
	return structuredClone(value);
}
