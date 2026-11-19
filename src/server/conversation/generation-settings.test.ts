import { createConversationWithHistory, pairChat } from "../test-fixtures/conversation";
import { readConversationGenerationSettings, executeConversationCommand } from ".";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { InvalidConversationCommandError } from ".";
import type { CanonicalGenerationSettings } from "../../shared/contract/generation-settings";


// An update command carries the complete canonical declaration: the server
// accepts no omitted client fields. Overrides state only what one test's
// assertion focuses on.
const completeSettings = (
	overrides: Partial<CanonicalGenerationSettings> = {},
): CanonicalGenerationSettings => ({
	modelId: "deepseek-chat",
	temperature: null,
	topP: null,
	frequencyPenalty: null,
	presencePenalty: null,
	contextLimit: 4096,
	responseBudget: 128,
	safetyAllowance: 500,
	siblingGenerationLimit: 4,
	continuationStrategy: "instruction",
	continuationInstruction:
		"Continue the narrative naturally without repeating the previous text.",
	continuationPrefillSuffix: "",
	repeatedImagePlacement: "last",
	requestOverrides: {
		"chat-completions": {},
		responses: {},
		"anthropic-messages": {},
	},
	...overrides,
});

describe("Conversation Generation Settings", () => {
	let database: Database;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
	});

	afterEach(() => {
		database.close();
	});

	test("rejects persisted settings outside the sampling, budget and limit domains", () => {
		const conversation = createConversationWithHistory(database, { name: "Corrupt settings", participants: [] });
		for (const [field, value] of [
			["temperature", 3], ["contextLimit", 0], ["responseBudget", -1],
			["safetyAllowance", -1], ["siblingGenerationLimit", 0],
			["contextLimit", 1.5], ["responseBudget", 1.5], ["safetyAllowance", 1.5], ["siblingGenerationLimit", 1.5],
		] satisfies [keyof CanonicalGenerationSettings, number][]) {
			database.query("UPDATE conversation_generation_settings SET settings_json = ? WHERE conversation_id = ?")
				.run(JSON.stringify(completeSettings({ [field]: value })), conversation.id);
			expect(() => readConversationGenerationSettings(database, conversation.id)).toThrow(`Conversation ${conversation.id} Generation Settings are corrupt`);
		}
	});

	test("rejects stored Request Overrides with missing, unknown or non-object namespaces", () => {
		const conversation = createConversationWithHistory(database, { name: "Corrupt overrides", participants: [] });
		for (const overrides of [
			{ responses: {}, "anthropic-messages": {} },
			{ "chat-completions": [], responses: {}, "anthropic-messages": {} },
			{ "chat-completions": {}, responses: {}, "anthropic-messages": {}, unexpected: {} },
		]) {
			database.query("UPDATE conversation_generation_settings SET settings_json = ? WHERE conversation_id = ?")
				.run(JSON.stringify({ ...completeSettings(), requestOverrides: overrides }), conversation.id);
			expect(() => readConversationGenerationSettings(database, conversation.id)).toThrow(`Conversation ${conversation.id} Generation Request Overrides are corrupt`);
		}
	});

	test("rejects invalid Safety allowance values through the typed settings error", () => {
		const conversation = pairChat(database, "Invalid budget settings");
		const module = database;
		const settings = completeSettings({ contextLimit: 4096, responseBudget: 128 });

		for (const safetyAllowance of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => executeConversationCommand(module, {
				conversationId: conversation.id,
				expectedRevision: conversation.revision,
				action: {
					type: "update-generation-settings",
					settings: { ...settings, safetyAllowance },
				},
			})).toThrow(InvalidConversationCommandError);
		}
		expect(readConversationGenerationSettings(module, conversation.id)?.safetyAllowance).toBe(500);
	});

	test("returns undefined for a nonexistent Conversation", () => {
		const module = database;

		expect(readConversationGenerationSettings(module, 9999)).toBeUndefined();
	});

	test("round-trips every canonical field through the settings write and read", () => {
		const conversation = pairChat(database, "Round-trip settings");
		const module = database;
		const submitted: CanonicalGenerationSettings = {
			modelId: "  round-trip-model  ",
			temperature: 0.5,
			topP: 0.9,
			frequencyPenalty: -1,
			presencePenalty: 1.5,
			contextLimit: 8192,
			responseBudget: 256,
			safetyAllowance: 64,
			siblingGenerationLimit: 2,
			continuationStrategy: "assistant-prefill",
			continuationInstruction: "Keep the voice.",
			continuationPrefillSuffix: "\n",
			repeatedImagePlacement: "last",
			requestOverrides: {
				"chat-completions": { stop: ["\n\nHuman:"] },
				responses: { max_output_tokens: 64 },
				"anthropic-messages": { top_k: 3 },
			},
		};

		executeConversationCommand(module, {
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: { type: "update-generation-settings", settings: submitted },
		});
		const stored = readConversationGenerationSettings(module, conversation.id);
		// The domain adapter owns trimming, so the model ID survives normalized
		// while every other canonical field round-trips exactly.
		expect(stored).toMatchObject({ ...submitted, modelId: "round-trip-model" });
	});

});
