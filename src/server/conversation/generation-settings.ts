import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import {
	conversationGenerationSettingsTable,
} from "../database/schema";
import {
	connectConversationDatabase,
	findConversation,
	type ConversationDatabase,
} from "./internal";
import { InvalidConversationCommandError, ConversationNotFoundError } from "./errors";
import { DEFAULT_CONTINUATION_STRATEGY, DEFAULT_SIBLING_GENERATION_LIMIT } from "./generation-defaults";
import {
	isRepeatedImagePlacement,
	type CanonicalGenerationSettings,
	type GenerationSettingsField,
} from "../../shared/contract/generation-settings";
import type {
	ConversationGenerationSettings,
	ConversationGenerationSettingsInput,
	ContinuationPrefillSuffix,
	GenerationRequestOverrides,
} from "./types";

const DEFAULT_REQUEST_OVERRIDES = {
	"chat-completions": {},
	responses: {},
	"anthropic-messages": {},
} as const;

export const DEFAULT_SAFETY_ALLOWANCE = 500;
export const DEFAULT_CONTINUATION_INSTRUCTION =
	"Continue the narrative naturally without repeating the previous text.";

// ==[HUMAN APPROVED]== The domain default derives from the canonical Generation Settings
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
	safetyAllowance: DEFAULT_SAFETY_ALLOWANCE,
	siblingGenerationLimit: DEFAULT_SIBLING_GENERATION_LIMIT,
	continuationStrategy: DEFAULT_CONTINUATION_STRATEGY,
	continuationInstruction: DEFAULT_CONTINUATION_INSTRUCTION,
	continuationPrefillSuffix: "",
	repeatedImagePlacement: "last",
	requestOverrides: DEFAULT_REQUEST_OVERRIDES,
};

// ==[HUMAN APPROVED]== Database storage participates with every canonical field: each one has a
// settings-table column, and rows round-trip reads and writes field for
// field. The column map below is the storage boundary's exhaustive
// participation decision.

type SettingsRow = typeof conversationGenerationSettingsTable.$inferSelect;

// ==[HUMAN APPROVED]== The settings-table column for each canonical field. Compile-locked to the
// canonical vocabulary: adding a field fails typecheck until its column is
// named here, and the read and write paths below consume this map.
const settingsColumn = {
	modelId: "model_id",
	temperature: "temperature",
	topP: "top_p",
	frequencyPenalty: "frequency_penalty",
	presencePenalty: "presence_penalty",
	contextLimit: "context_limit",
	responseBudget: "response_budget",
	safetyAllowance: "safety_allowance",
	siblingGenerationLimit: "sibling_generation_limit",
	continuationStrategy: "continuation_strategy",
	continuationInstruction: "continuation_instruction",
	continuationPrefillSuffix: "continuation_prefill_suffix",
	repeatedImagePlacement: "repeated_image_placement",
	requestOverrides: "request_overrides_json",
} as const satisfies Record<GenerationSettingsField, keyof SettingsRow>;

// ==[HUMAN APPROVED]== The persisted row values for each canonical field. Adding a canonical
// field fails typecheck here before it can reach the database.
type SettingsRowValues = {
	[K in GenerationSettingsField as (typeof settingsColumn)[K]]: SettingsRow[(typeof settingsColumn)[K]];
};

const settingsRowValues = (settings: CanonicalGenerationSettings): SettingsRowValues => ({
	model_id: settings.modelId,
	temperature: settings.temperature,
	top_p: settings.topP,
	frequency_penalty: settings.frequencyPenalty,
	presence_penalty: settings.presencePenalty,
	context_limit: settings.contextLimit,
	response_budget: settings.responseBudget,
	safety_allowance: settings.safetyAllowance,
	sibling_generation_limit: settings.siblingGenerationLimit,
	continuation_strategy: settings.continuationStrategy,
	continuation_instruction: settings.continuationInstruction,
	continuation_prefill_suffix: settings.continuationPrefillSuffix,
	repeated_image_placement: settings.repeatedImagePlacement,
	request_overrides_json: JSON.stringify(settings.requestOverrides),
});

const modelSelectionRowValues = (settings: ConversationGenerationSettings) => ({
	connection_profile_id: settings.connectionProfileId,
	model_id: settings.modelId,
});

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

export function updateConversationGenerationSettings(
	db: ConversationDatabase,
	conversationId: number,
	input: ConversationGenerationSettingsInput,
): ConversationGenerationSettings {
	const normalized = normalizeGenerationSettings(input);
	db.insert(conversationGenerationSettingsTable)
		.values({ conversation_id: conversationId })
		.onConflictDoNothing()
		.run();
	const updated = db
		.update(conversationGenerationSettingsTable)
		.set(settingsRowValues(normalized))
		.where(eq(conversationGenerationSettingsTable.conversation_id, conversationId))
		.returning()
		.get();
	if (updated === undefined) {
		throw new ConversationNotFoundError(conversationId);
	}
	return readGenerationSettingsRow(updated);
}

// ==[HUMAN APPROVED]== Per-field normalization over the canonical vocabulary. Compile-locked:
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

// ==[HUMAN APPROVED]== The row value for each canonical field, parsed back into the domain
// vocabulary. Compile-locked to the canonical field map; corrupt persisted
// values fail loudly instead of decoding as defaults.
type SettingsFieldRowReader = {
	readonly [K in GenerationSettingsField]: (row: SettingsRow) => CanonicalGenerationSettings[K];
};

const readSettingsFieldValue: SettingsFieldRowReader = {
	modelId: (row) => row[settingsColumn.modelId],
	temperature: (row) => row[settingsColumn.temperature],
	topP: (row) => row[settingsColumn.topP],
	frequencyPenalty: (row) => row[settingsColumn.frequencyPenalty],
	presencePenalty: (row) => row[settingsColumn.presencePenalty],
	contextLimit: (row) => row[settingsColumn.contextLimit],
	responseBudget: (row) => row[settingsColumn.responseBudget],
	safetyAllowance: (row) => row[settingsColumn.safetyAllowance],
	siblingGenerationLimit: (row) => row[settingsColumn.siblingGenerationLimit],
	continuationStrategy: (row) =>
		parseContinuationStrategy(row[settingsColumn.continuationStrategy]),
	continuationInstruction: (row) => row[settingsColumn.continuationInstruction],
	continuationPrefillSuffix: (row) =>
		parseContinuationPrefillSuffix(row[settingsColumn.continuationPrefillSuffix]),
	repeatedImagePlacement: (row) => parseRepeatedImagePlacement(row[settingsColumn.repeatedImagePlacement]),
	requestOverrides: (row) => parseRequestOverrides(row[settingsColumn.requestOverrides]),
};

const readGenerationSettingsRow = (row: SettingsRow): ConversationGenerationSettings => ({
	connectionProfileId: row.connection_profile_id,
	modelId: readSettingsFieldValue.modelId(row),
	temperature: readSettingsFieldValue.temperature(row),
	topP: readSettingsFieldValue.topP(row),
	frequencyPenalty: readSettingsFieldValue.frequencyPenalty(row),
	presencePenalty: readSettingsFieldValue.presencePenalty(row),
	contextLimit: readSettingsFieldValue.contextLimit(row),
	responseBudget: readSettingsFieldValue.responseBudget(row),
	safetyAllowance: readSettingsFieldValue.safetyAllowance(row),
	siblingGenerationLimit: readSettingsFieldValue.siblingGenerationLimit(row),
	continuationStrategy: readSettingsFieldValue.continuationStrategy(row),
	continuationInstruction: readSettingsFieldValue.continuationInstruction(row),
	continuationPrefillSuffix: readSettingsFieldValue.continuationPrefillSuffix(row),
	repeatedImagePlacement: readSettingsFieldValue.repeatedImagePlacement(row),
	requestOverrides: readSettingsFieldValue.requestOverrides(row),
});

export function updateConversationModelSelection(
	db: ConversationDatabase,
	conversationId: number,
	settings: ConversationGenerationSettings,
): ConversationGenerationSettings {
	const updated = db
		.update(conversationGenerationSettingsTable)
		.set(modelSelectionRowValues(settings))
		.where(eq(conversationGenerationSettingsTable.conversation_id, conversationId))
		.returning()
		.get();
	if (updated === undefined) throw new ConversationNotFoundError(conversationId);
	return readGenerationSettingsRow(updated);
}

function parseContinuationPrefillSuffix(value: string): ContinuationPrefillSuffix {
	if (value === "" || value === " " || value === "\n" || value === "\n\n") return value;
	throw new Error("Conversation Continuation prefill suffix is corrupt.");
}

function parseRepeatedImagePlacement(
	value: string,
): ConversationGenerationSettings["repeatedImagePlacement"] {
	if (isRepeatedImagePlacement(value)) return value;
	throw new Error("Conversation Repeated Image Placement is corrupt.");
}

function parseContinuationStrategy(
	value: string,
): ConversationGenerationSettings["continuationStrategy"] {
	if (value === "instruction" || value === "assistant-prefill") return value;
	throw new Error("Conversation Continuation strategy is corrupt.");
}

function validateContinuationPrefillSuffix(
	value: ContinuationPrefillSuffix,
): ContinuationPrefillSuffix {
	if (value === "" || value === " " || value === "\n" || value === "\n\n") return value;
	throw new InvalidConversationCommandError(
		"Continuation prefill suffix must be none, a space, a newline, or a double newline.",
	);
}

function parseRequestOverrides(value: string): ConversationGenerationSettings["requestOverrides"] {
	try {
		// ==[HUMAN APPROVED]== SAFETY: the persisted value is written only by settingsRowValues, from
		// a cloneRequestOverrides-verified draft; parsing it restores the same
		// closed JSON value domain, and cloneRequestOverrides re-verifies all
		// three required format namespaces before returning it.
		const parsed = JSON.parse(value) as ConversationGenerationSettings["requestOverrides"];
		return cloneRequestOverrides(parsed);
	} catch {
		throw new Error("Conversation Generation Request Overrides are corrupt.");
	}
}

function cloneRequestOverrides(
	value: ConversationGenerationSettings["requestOverrides"],
): ConversationGenerationSettings["requestOverrides"] {
	const copy = (candidate: GenerationRequestOverrides): GenerationRequestOverrides => {
		const serialized = JSON.stringify(candidate);
		if (serialized === undefined) {
			throw new InvalidConversationCommandError("Request Overrides must be JSON values.");
		}
		// ==[HUMAN APPROVED]== SAFETY: serialized is produced from the typed GenerationRequestOverrides
		// contract, so parsing it restores the same closed JSON value domain.
		return JSON.parse(serialized) as GenerationRequestOverrides;
	};
	return {
		"chat-completions": copy(value["chat-completions"] ?? {}),
		responses: copy(value.responses ?? {}),
		"anthropic-messages": copy(value["anthropic-messages"] ?? {}),
	};
}
