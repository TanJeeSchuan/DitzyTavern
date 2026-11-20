import { emptyPromptChannels } from "../../shared/definition";
import { readTestConversationSnapshot, createConversationWithHistory, checkpointFromStart, participantSeed } from "../test-fixtures/conversation";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { acceptGeneration, editMacroVariables, readConversationPromptPreset } from "../conversation";
import { resolveConversationGeneration } from "../conversation";
import { readMacroWrites } from "../prompt-macros";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readVariantData } from "../conversation";
import { captureGeneration } from "./generate-capture";
import { capturedAcceptanceFields } from "./generate-capture-projections";
import { recoverActiveGenerations } from "./generation-recovery";

describe("Conversation-persistent prompt macro variables", () => {
	let database: Database;
	const activePresetId = (conversationId: number) => {
		const preset = readConversationPromptPreset(database, conversationId);
		if (preset === undefined) throw new Error("Conversation has no Prompt Preset.");
		return preset.id;
	};
	const macroWritesOf = (variantId: number, presetId: number) => readMacroWrites(readVariantData(drizzle(database), [variantId], ["macroWrites"]).get(variantId)?.macroWrites ?? [], presetId);

	beforeEach(() => {
		database = openObservedDatabase();
	});
	afterEach(() => database.close());

	test("threads recipe writes and carries only the selected Variant's resolved journal", async () => {
		const initial = createConversationWithHistory(database, {
			name: "Macro variables",
			participants: [
				participantSeed("Writer", { prompt: {
							...emptyPromptChannels(),
							systemInstruction: "{{setvar::turn::{{incvar::turn}}}}",
							identity: "turn={{getvar::turn}}",
						} }),
				participantSeed("Model", { prompt: {
							...emptyPromptChannels(),
							systemInstruction: "{{setvar::turn::{{incvar::turn}}}}{{if::{{getvar::enabled}}}}yes{{else}}no{{/if}}",
							identity: "turn={{getvar::turn}}",
						} }),
			],
			control: { human: 0, model: 1 },
		});
		const promptPresetId = activePresetId(initial.id);
		const scope = { conversationId: initial.id, promptPresetId, position: 0, operation: "set" } as const;
		const turn = editMacroVariables(database, { ...scope, expectedRevision: initial.revision, name: "turn", value: 5 });
		const { conversation } = editMacroVariables(database, { ...scope, expectedRevision: turn.conversation.revision, name: "enabled", value: true });

		const first = await captureGeneration(database, { kind: "send", content: "Hello" }, {connection: null, conversationId: conversation.id });
		expect(first.plan.promptPlan.blocks.map((block) => block.content)).toContain("turn=6");
		expect(first.macroWrites).toEqual([
			{ name: "turn", value: 6, operation: "set" },
			{ name: "turn", value: "6", operation: "set" },
		]);

		const fields = capturedAcceptanceFields(first, "2026-09-12T00:00:00.000Z");
		const accepted = acceptGeneration(database, fields, { kind: "send", expectedRevision: conversation.revision, content: "Hello" });
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
		expect(macroWritesOf(generated.id, promptPresetId)).toEqual([
			{ name: "turn", value: "6", operation: "set" },
		]);

		const second = await captureGeneration(database, { kind: "send", content: "Again" }, {connection: null, conversationId: after.id });
		expect(second.plan.promptPlan.blocks.map((block) => block.content)).toContain("turn=7");
	});

	test("records one-time opening writes on the selected greeting Variant", async () => {
		const conversation = createConversationWithHistory(database, {
			name: "Macro greeting",
			participants: [
				participantSeed("Writer"),
				participantSeed("Model", { prompt: { ...emptyPromptChannels(), identity: "greeted={{getvar::greeted}}" }, openings: ["{{setvar::greeted::yes}}Hello"] }),
			],
			control: { human: 0, model: 1 },
		});
		const snapshot = readTestConversationSnapshot(database, conversation.id);
		if (snapshot === undefined) throw new Error("Conversation disappeared.");
		const greetingVariant = snapshot.messages[0]?.variants[0];
		if (greetingVariant === undefined) throw new Error("Greeting Variant disappeared.");
		expect(greetingVariant.content).toBe("Hello");
		expect(macroWritesOf(greetingVariant.id, activePresetId(conversation.id))).toEqual([
			{ name: "greeted", operation: "set", value: "yes" },
		]);
		const capture = await captureGeneration(database, { kind: "send", content: "Again" }, {connection: null, conversationId: snapshot.id });
		expect(capture.plan.promptPlan.blocks.map((block) => block.content)).toContain("greeted=yes");
	});

	test("retains pending writes when restart recovery terminalizes checkpointed output", async () => {
		const conversation = createConversationWithHistory(database, {
			name: "Recover macro writes",
			participants: [
				participantSeed("Writer"),
				participantSeed("Model", { prompt: { ...emptyPromptChannels(), systemInstruction: "{{setvar::recovered::yes}}" } }),
			],
			control: { human: 0, model: 1 },
		});
		const capture = await captureGeneration(database, { kind: "send", content: "Hello" }, {connection: null, conversationId: conversation.id });
		const fields = capturedAcceptanceFields(capture, "2026-09-12T00:00:00.000Z");
		const accepted = acceptGeneration(database, fields, { kind: "send", expectedRevision: conversation.revision, content: "Hello" });
		checkpointFromStart(database, {
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
		expect(macroWritesOf(variant.id, activePresetId(conversation.id))).toEqual([
			{ name: "recovered", operation: "set", value: "yes" },
		]);
	});
});
