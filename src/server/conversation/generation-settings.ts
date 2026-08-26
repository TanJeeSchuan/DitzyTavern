import { eq } from "drizzle-orm";
import { conversationGenerationSettingsTable } from "../database/schema";
import type { ConversationDatabase } from "./internal";
import { InvalidConversationCommandError, ConversationNotFoundError } from "./errors";
import type {
	ConversationGenerationSettings,
	ConversationGenerationSettingsInput,
	GenerationRequestOverrides,
} from "./types";

const DEFAULT_REQUEST_OVERRIDES = {
	"chat-completions": {},
	responses: {},
	"anthropic-messages": {},
} as const;

export const DEFAULT_SAFETY_ALLOWANCE = 500;

export const DEFAULT_CONVERSATION_GENERATION_SETTINGS: ConversationGenerationSettings = {
	modelId: "deepseek-chat",
	temperature: null,
	topP: null,
	frequencyPenalty: null,
	presencePenalty: null,
	contextLimit: 32768,
	responseBudget: 1024,
	safetyAllowance: DEFAULT_SAFETY_ALLOWANCE,
	requestOverrides: DEFAULT_REQUEST_OVERRIDES,
};

export function readConversationGenerationSettings(
	db: ConversationDatabase,
	conversationId: number,
): ConversationGenerationSettings | undefined {
	const row = db
		.select()
		.from(conversationGenerationSettingsTable)
		.where(eq(conversationGenerationSettingsTable.chat_id, conversationId))
		.get();
	return row === undefined ? undefined : readGenerationSettingsRow(row);
}

export function updateConversationGenerationSettings(
	db: ConversationDatabase,
	conversationId: number,
	input: ConversationGenerationSettingsInput,
): ConversationGenerationSettings {
	const normalized = validateGenerationSettings(input);
	db.insert(conversationGenerationSettingsTable)
		.values({ chat_id: conversationId })
		.onConflictDoNothing()
		.run();
	const updated = db
		.update(conversationGenerationSettingsTable)
		.set({
			model_id: normalized.modelId,
			temperature: normalized.temperature,
			top_p: normalized.topP,
			frequency_penalty: normalized.frequencyPenalty,
			presence_penalty: normalized.presencePenalty,
		context_limit: normalized.contextLimit,
		response_budget: normalized.responseBudget,
		safety_allowance: normalized.safetyAllowance,
		request_overrides_json: JSON.stringify(normalized.requestOverrides),
		})
		.where(eq(conversationGenerationSettingsTable.chat_id, conversationId))
		.returning()
		.get();
	if (updated === undefined) {
		throw new ConversationNotFoundError(conversationId);
	}
	return readGenerationSettingsRow(updated);
}

function readGenerationSettingsRow(
	row: typeof conversationGenerationSettingsTable.$inferSelect,
): ConversationGenerationSettings {
	return {
		modelId: row.model_id,
		temperature: row.temperature,
		topP: row.top_p,
		frequencyPenalty: row.frequency_penalty,
		presencePenalty: row.presence_penalty,
		contextLimit: row.context_limit,
		responseBudget: row.response_budget,
		safetyAllowance: row.safety_allowance,
		requestOverrides: parseRequestOverrides(row.request_overrides_json),
	};
}

function validateGenerationSettings(
	input: ConversationGenerationSettingsInput,
): ConversationGenerationSettings {
	const modelId = input.modelId.trim();
	if (modelId.length === 0) {
		throw new InvalidConversationCommandError("A model ID is required.");
	}
	for (const [label, value] of [
		["temperature", input.temperature],
		["topP", input.topP],
		["frequencyPenalty", input.frequencyPenalty],
		["presencePenalty", input.presencePenalty],
	] as const) {
		if (value !== null && (!Number.isFinite(value) || value < -2 || value > 2)) {
			throw new InvalidConversationCommandError(
				`${label} must be null or a finite value between -2 and 2.`,
			);
		}
	}
	if (!Number.isInteger(input.contextLimit) || input.contextLimit <= 0) {
		throw new InvalidConversationCommandError("Context limit must be a positive whole number.");
	}
	if (!Number.isInteger(input.responseBudget) || input.responseBudget <= 0) {
		throw new InvalidConversationCommandError("Response budget must be a positive whole number.");
	}
	const safetyAllowance = input.safetyAllowance ?? DEFAULT_SAFETY_ALLOWANCE;
	if (!Number.isInteger(safetyAllowance) || safetyAllowance < 0) {
		throw new InvalidConversationCommandError(
			"Safety allowance must be a non-negative whole number.",
		);
	}
	const requestOverrides = cloneRequestOverrides(input.requestOverrides);
	return {
		modelId,
		temperature: input.temperature,
		topP: input.topP,
		frequencyPenalty: input.frequencyPenalty,
		presencePenalty: input.presencePenalty,
		contextLimit: input.contextLimit,
		responseBudget: input.responseBudget,
		safetyAllowance,
		requestOverrides,
	};
}

function parseRequestOverrides(value: string): ConversationGenerationSettings["requestOverrides"] {
	try {
		// SAFETY: the persisted value is written only by validateGenerationSettings;
		// cloneRequestOverrides verifies all three required format namespaces by
		// forcing each value through JSON serialization before returning it.
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
		// SAFETY: serialized is produced from the typed GenerationRequestOverrides
		// contract, so parsing it restores the same closed JSON value domain.
		return JSON.parse(serialized) as GenerationRequestOverrides;
	};
	return {
		"chat-completions": copy(value["chat-completions"] ?? {}),
		responses: copy(value.responses ?? {}),
		"anthropic-messages": copy(value["anthropic-messages"] ?? {}),
	};
}
