import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import {
	createConversationModule,
	InvalidConversationCommandError,
	StaleConversationRevisionError,
} from ".";
import { DEFAULT_CONVERSATION_GENERATION_SETTINGS } from "./generation-settings";
import {
	GENERATION_SETTINGS_FIELDS,
	type CanonicalGenerationSettings,
} from "../../shared/contract/generation-settings";

const prompt = {
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
};

const createConversation = (database: Database, name: string) =>
	createConversationModule(database).create({
		name,
		participants: [
			{ definition: { name: "Writer", prompt, openings: [] } },
			{ definition: { name: "Maren", prompt, openings: [] } },
		],
		control: { human: 0, model: 1 },
	});

// One editor's complete Generation Settings write: distinctive values in
// every canonical field so a stale-field restore anywhere in the aggregate
// shows up as a failed comparison.
const configuredSettings = (): CanonicalGenerationSettings => ({
	modelId: "deepseek-chat",
	temperature: 1.5,
	topP: 0.9,
	frequencyPenalty: -1,
	presencePenalty: 0.5,
	contextLimit: 4096,
	responseBudget: 128,
	safetyAllowance: 64,
	siblingGenerationLimit: 2,
	continuationStrategy: "assistant-prefill",
	continuationInstruction: "Keep the voice.",
	continuationPrefillSuffix: "\n",
	requestOverrides: {
		"chat-completions": { stop: ["\n\nHuman:"] },
		responses: { max_output_tokens: 64 },
		"anthropic-messages": { top_k: 3 },
	},
});

describe("set-generation-model", () => {
	let database: Database;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
	});

	afterEach(() => {
		database.close();
	});

	test("changes only the model selection between full writes", () => {
		const conversation = createConversation(database, "Focused model command");
		const module = createConversationModule(database);
		module.execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: { type: "update-generation-settings", settings: configuredSettings() },
		});
		const before = module.getGenerationSettings(conversation.id);
		if (before === undefined) throw new Error("Stored settings missing.");

		const updated = module.execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision + 1,
			action: { type: "set-generation-model", modelId: "  qwen3-max  " },
		});
		const stored = module.getGenerationSettings(conversation.id);
		if (stored === undefined) throw new Error("Stored settings missing.");

		// The owning domain adapter owns trimming, so the submitted model ID
		// survives normalized while every other canonical field keeps the
		// other editor's committed values.
		expect(stored.modelId).toBe("qwen3-max");
		for (const field of GENERATION_SETTINGS_FIELDS) {
			if (field === "modelId") continue;
			expect(stored[field]).toEqual(before[field]);
		}
		expect(updated.revision).toBe(conversation.revision + 2);
	});

	test("creates the default settings under the submitted model when none are stored", () => {
		const conversation = createConversation(database, "Unconfigured model command");
		const module = createConversationModule(database);

		module.execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: { type: "set-generation-model", modelId: "qwen3-max" },
		});

		const stored = module.getGenerationSettings(conversation.id);
		expect(stored).toEqual({ ...DEFAULT_CONVERSATION_GENERATION_SETTINGS, modelId: "qwen3-max" });
	});

	test("rejects a blank model ID and keeps the stored settings", () => {
		const conversation = createConversation(database, "Blank model command");
		const module = createConversationModule(database);
		module.execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: { type: "update-generation-settings", settings: configuredSettings() },
		});

		expect(() =>
			module.execute({
				conversationId: conversation.id,
				expectedRevision: conversation.revision + 1,
				action: { type: "set-generation-model", modelId: "   " },
			}),
		).toThrow(InvalidConversationCommandError);
		expect(module.getGenerationSettings(conversation.id)?.modelId).toBe("deepseek-chat");
	});

	test("requires the current Conversation revision", () => {
		const conversation = createConversation(database, "Stale model command");
		const module = createConversationModule(database);

		expect(() =>
			module.execute({
				conversationId: conversation.id,
				expectedRevision: conversation.revision + 5,
				action: { type: "set-generation-model", modelId: "qwen3-max" },
			}),
		).toThrow(StaleConversationRevisionError);
		expect(module.getGenerationSettings(conversation.id)?.modelId).toBe(
			DEFAULT_CONVERSATION_GENERATION_SETTINGS.modelId,
		);
	});
});
