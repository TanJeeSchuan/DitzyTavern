import { readTestConversationSnapshot, createConversationWithHistory } from "../test-fixtures/conversation";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { acceptConversationTailGeneration } from "../conversation";
import { checkpointConversationGeneration, resolveConversationGeneration } from "../conversation";
import { macroInitialValuesToData, readMacroWrites } from "../prompt-macros";
import type { MacroValue } from "../../shared/prompt-macro-engine";
import {
	captureGeneration,
	capturedAcceptanceFields,
} from "./generate-capture";
import { recoverActiveGenerations } from "./generation-recovery";

describe("Conversation-persistent prompt macro variables", () => {
	let database: Database;

	beforeEach(() => {
		database = openObservedDatabase();
	});
	afterEach(() => database.close());

	test("threads recipe writes and carries only the selected Variant's resolved journal", async () => {
		const conversation = createConversationWithHistory(database, {
			name: "Macro variables",
			participants: [
				{
					definition: {
						name: "Writer",
						prompt: {
							systemInstruction: "{{setvar::turn::{{incvar::turn}}}}",
							identity: "turn={{getvar::turn}}",
							scenario: "",
							exampleDialogue: "",
							postHistoryInstruction: "",
						},
						openings: [],
					},
				},
				{
					definition: {
						name: "Model",
						prompt: {
							systemInstruction: "{{setvar::turn::{{incvar::turn}}}}{{if::{{getvar::enabled}}}}yes{{else}}no{{/if}}",
							identity: "turn={{getvar::turn}}",
							scenario: "",
							exampleDialogue: "",
							postHistoryInstruction: "",
						},
						openings: [],
					},
				},
			],
			control: { human: 0, model: 1 },
			data: macroInitialValuesToData(1, new Map<string, MacroValue>([["turn", 5], ["enabled", true]])),
		});

		const first = await captureGeneration(database, { kind: "send", content: "Hello" }, {connection: null, conversationId: conversation.id });
		expect(first.plan.promptPlan.blocks.map((block) => block.content)).toContain("turn=6");
		expect(first.macroWrites).toEqual([
			{ name: "turn", value: 6, operation: "set" },
			{ name: "turn", value: "6", operation: "set" },
		]);

		const accepted = acceptConversationTailGeneration(database, {
			...capturedAcceptanceFields(first, { conversationId: conversation.id, timestamp: "2026-09-12T00:00:00.000Z" }),
			expectedRevision: conversation.revision,
			humanContent: "Hello",
		});
		resolveConversationGeneration(database, {
			conversationId: conversation.id,
			generationId: accepted.generationId,
			timestamp: "2026-09-12T00:00:01.000Z",
			content: "Done",
		});

		const after = readTestConversationSnapshot(database, conversation.id);
		if (after === undefined) throw new Error("Conversation disappeared.");
		const generated = after.messages.at(-1)?.variants.find((variant) => variant.selected);
		if (generated === undefined) throw new Error("Generated Variant disappeared.");
		expect(readMacroWrites(generated.data, 1)).toEqual([
			{ name: "turn", value: "6", operation: "set" },
		]);

		const second = await captureGeneration(database, { kind: "send", content: "Again" }, {connection: null, conversationId: after.id });
		expect(second.plan.promptPlan.blocks.map((block) => block.content)).toContain("turn=7");
	});

	test("records one-time opening writes on the selected greeting Variant", async () => {
		const conversation = createConversationWithHistory(database, {
			name: "Macro greeting",
			participants: [
				{
					definition: {
						name: "Writer",
						prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" },
						openings: [],
					},
				},
				{
					definition: {
						name: "Model",
						prompt: { systemInstruction: "", identity: "greeted={{getvar::greeted}}", scenario: "", exampleDialogue: "", postHistoryInstruction: "" },
						openings: ["{{setvar::greeted::yes}}Hello"],
					},
				},
			],
			control: { human: 0, model: 1 },
		});
		const snapshot = readTestConversationSnapshot(database, conversation.id);
		if (snapshot === undefined) throw new Error("Conversation disappeared.");
		const greetingVariant = snapshot.messages[0]?.variants[0];
		if (greetingVariant === undefined) throw new Error("Greeting Variant disappeared.");
		expect(greetingVariant.content).toBe("Hello");
		expect(readMacroWrites(greetingVariant.data, 1)).toEqual([
			{ name: "greeted", operation: "set", value: "yes" },
		]);
		const capture = await captureGeneration(database, { kind: "send", content: "Again" }, {connection: null, conversationId: snapshot.id });
		expect(capture.plan.promptPlan.blocks.map((block) => block.content)).toContain("greeted=yes");
	});

	test("retains pending writes when restart recovery terminalizes checkpointed output", async () => {
		const conversation = createConversationWithHistory(database, {
			name: "Recover macro writes",
			participants: [
				{
					definition: {
						name: "Writer",
						prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" },
						openings: [],
					},
				},
				{
					definition: {
						name: "Model",
						prompt: { systemInstruction: "{{setvar::recovered::yes}}", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" },
						openings: [],
					},
				},
			],
			control: { human: 0, model: 1 },
		});
		const capture = await captureGeneration(database, { kind: "send", content: "Hello" }, {connection: null, conversationId: conversation.id });
		const accepted = acceptConversationTailGeneration(database, {
			...capturedAcceptanceFields(capture, { conversationId: conversation.id, timestamp: "2026-09-12T00:00:00.000Z" }),
			expectedRevision: conversation.revision,
			humanContent: "Hello",
		});
		checkpointConversationGeneration(database, {
			conversationId: conversation.id,
			generationId: accepted.generationId,
			content: "Partial",
			reasoning: "Thinking",
		});
		expect(recoverActiveGenerations(database)).toMatchObject({ interrupted: 1, failed: 0 });
		const snapshot = readTestConversationSnapshot(database, conversation.id);
		if (snapshot === undefined) throw new Error("Conversation disappeared.");
		const variant = snapshot.messages.at(-1)?.variants.find((candidate) => candidate.selected);
		if (variant === undefined) throw new Error("Recovered Variant disappeared.");
		expect(variant.content).toBe("Partial");
		expect(readMacroWrites(variant.data, 1)).toEqual([
			{ name: "recovered", operation: "set", value: "yes" },
		]);
	});
});
