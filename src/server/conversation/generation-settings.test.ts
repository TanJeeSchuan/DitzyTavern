import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import {
	createConversationModule,
	InvalidConversationCommandError,
} from ".";
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

	test("persists the default and configured Safety allowance", () => {
		const conversation = createConversationModule(database).create({
			authorNote: "",
			name: "Budget settings",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const module = createConversationModule(database);

		expect(module.getGenerationSettings(conversation.id)?.safetyAllowance).toBe(500);
		const updated = module.execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: {
				type: "update-generation-settings",
				settings: completeSettings({ safetyAllowance: 777 }),
			},
		});

		expect(module.getGenerationSettings(conversation.id)?.safetyAllowance).toBe(777);
		expect(updated.revision).toBe(1);
	});

	test("persists and validates the parallel Sibling Generation limit", () => {
		const conversation = createConversationModule(database).create({
			authorNote: "",
			name: "Sibling limit settings",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const module = createConversationModule(database);
		expect(module.getGenerationSettings(conversation.id)?.siblingGenerationLimit).toBe(4);
		module.execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: {
				type: "update-generation-settings",
				settings: completeSettings({ siblingGenerationLimit: 2 }),
			},
		});
		expect(module.getGenerationSettings(conversation.id)?.siblingGenerationLimit).toBe(2);
	});

	test("rejects invalid Safety allowance values through the typed settings error", () => {
		const conversation = createConversationModule(database).create({
			authorNote: "",
			name: "Invalid budget settings",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const module = createConversationModule(database);
		const settings = completeSettings({ contextLimit: 4096, responseBudget: 128 });

		for (const safetyAllowance of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => module.execute({
				conversationId: conversation.id,
				expectedRevision: conversation.revision,
				action: {
					type: "update-generation-settings",
					settings: { ...settings, safetyAllowance },
				},
			})).toThrow(InvalidConversationCommandError);
		}
		expect(module.getGenerationSettings(conversation.id)?.safetyAllowance).toBe(500);
	});

	test("returns undefined for a nonexistent Conversation", () => {
		const module = createConversationModule(database);

		expect(module.getGenerationSettings(9999)).toBeUndefined();
	});

	test("round-trips every canonical field through the settings write and read", () => {
		const conversation = createConversationModule(database).create({
			authorNote: "",
			name: "Round-trip settings",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
				
			],
			control: { human: 0, model: 1 },
		});
		const module = createConversationModule(database);
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

		module.execute({
			conversationId: conversation.id,
			expectedRevision: conversation.revision,
			action: { type: "update-generation-settings", settings: submitted },
		});
		const stored = module.getGenerationSettings(conversation.id);
		if (stored === undefined) throw new Error("Stored settings missing.");

		// The domain adapter owns trimming, so the model ID survives normalized
		// while every other canonical field round-trips exactly.
		for (const field of GENERATION_SETTINGS_FIELDS) {
			const expected = field === "modelId" ? "round-trip-model" : submitted[field];
			expect(stored[field]).toEqual(expected);
		}
	});

});
