import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import { openDatabase } from "../database/database";
import {
	createConversationModule,
	InvalidConversationCommandError,
} from ".";
import {
	conversationSettingsRowAdapter,
	DEFAULT_CONVERSATION_GENERATION_SETTINGS,
} from "./generation-settings";
import {
	canonicalGenerationSettings,
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

describe("Conversation Generation Settings", () => {
	let database: Database;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
	});

	afterEach(() => {
		database.close();
	});

	test("persists the default and configured Safety allowance", () => {
		const conversation = createConversationModule(database).create({
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
				settings: {
					modelId: "deepseek-chat",
					temperature: null,
					topP: null,
					frequencyPenalty: null,
					presencePenalty: null,
					contextLimit: 4096,
					responseBudget: 128,
					safetyAllowance: 777,
					requestOverrides: {
						"chat-completions": {},
						responses: {},
						"anthropic-messages": {},
					},
				},
			},
		});

		expect(module.getGenerationSettings(conversation.id)?.safetyAllowance).toBe(777);
		expect(updated.revision).toBe(1);
	});

	test("persists and validates the parallel Sibling Generation limit", () => {
		const conversation = createConversationModule(database).create({
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
				settings: {
					modelId: "deepseek-chat",
					temperature: null,
					topP: null,
					frequencyPenalty: null,
					presencePenalty: null,
					contextLimit: 4096,
					responseBudget: 128,
					siblingGenerationLimit: 2,
					requestOverrides: {
						"chat-completions": {},
						responses: {},
						"anthropic-messages": {},
					},
				},
			},
		});
		expect(module.getGenerationSettings(conversation.id)?.siblingGenerationLimit).toBe(2);
	});

	test("rejects invalid Safety allowance values through the typed settings error", () => {
		const conversation = createConversationModule(database).create({
			name: "Invalid budget settings",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const module = createConversationModule(database);
		const settings = {
			modelId: "deepseek-chat",
			temperature: null,
			topP: null,
			frequencyPenalty: null,
			presencePenalty: null,
			contextLimit: 4096,
			responseBudget: 128,
			requestOverrides: {
				"chat-completions": {},
				responses: {},
				"anthropic-messages": {},
			},
		};

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

	test("keeps the domain settings aligned with the canonical declaration", () => {
		// The domain type derives from the canonical declaration; the default
		// settings and every normalized write must satisfy the shared schema.
		expect(Value.Check(canonicalGenerationSettings, DEFAULT_CONVERSATION_GENERATION_SETTINGS)).toBe(true);
		expect(conversationSettingsRowAdapter.adapter).toBe("conversation-settings-row");
		expect(Object.keys(conversationSettingsRowAdapter.fields).sort())
			.toEqual([...GENERATION_SETTINGS_FIELDS].sort());
	});
});
