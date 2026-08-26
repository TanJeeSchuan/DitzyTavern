import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../database/database";
import {
	createConversationModule,
	InvalidConversationCommandError,
} from ".";

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
});
