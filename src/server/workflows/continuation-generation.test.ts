import { readTestConversationSnapshot, createConversationWithHistory } from "../test-fixtures/conversation";
import {
	stopConversationGeneration,
	executeConversationCommand,
	readVariantDetails,
} from "../conversation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ParticipantDefinition } from "../conversation";
import { createFakeModelClient, type ModelClientGenerationInput } from "../model-client";
import type { PromptPlan } from "../prompt-compiler";
import { runGenerationLifecycle } from ".";
import { generateTerminalTailFixture } from "./test-fixtures";
import { openObservedDatabase, applyCommand, requireSnapshot } from "../test-fixtures/conversation";
import { createGenerationPreviewAsync } from "./generation-preview";

const definition = (name: string): ParticipantDefinition => ({
	name,
	prompt: {
		systemInstruction: "Write well.",
		identity: "I am {{self}}.",
		scenario: "A quiet room.",
		exampleDialogue: "",
		postHistoryInstruction: "",
	},
	openings: [],
});

describe("Continuation Generation", () => {
	let database: Database;
	let conversationId: number;
	let humanId: number;
	let modelId: number;

	beforeEach(() => {
		database = openObservedDatabase();
		const snapshot = createConversationWithHistory(database, {
			name: "Continuation Chat",
			participants: [
				{ definition: definition("Writer") },
				{ definition: definition("Maren") },
			],
			control: { human: 0, model: 1 },
			messages: [{
				timestamp: "2026-08-27T00:00:00Z",
				variants: [{ content: "The first scene ends here.", timestamp: "2026-08-27T00:00:00Z", selected: true }],
				authorParticipantIndex: 1,
			}],
		});
		conversationId = snapshot.id;
		humanId = snapshot.cast[0]?.id ?? -1;
		modelId = snapshot.cast[1]?.id ?? -1;
	});

	afterEach(() => {
		database.close();
	});

	// Generation results carry the Conversation header; Message assertions
	// re-read the full snapshot immediately after the attempt they follow.
	const currentSnapshot = () =>
		requireSnapshot(database, conversationId);

	test("a failed terminal write preserves the generated checkpoint for recovery", async () => {
		const module = database;
		const before = readTestConversationSnapshot(module, conversationId);
		if (before === undefined) throw new Error("Missing Conversation.");
		database.exec("CREATE TRIGGER fail_terminal BEFORE INSERT ON generation_replay BEGIN SELECT RAISE(ABORT, 'terminal unavailable'); END");
		await expect(runGenerationLifecycle(database, {connection: null,target: { kind: "continuation" },
			conversationId,
			expectedRevision: before.revision,
			modelClient: createFakeModelClient(() => "Keep the generated output."),
		})).rejects.toThrow("terminal unavailable");
		const after = readTestConversationSnapshot(module, conversationId);
		expect(after?.activeGenerations).toHaveLength(1);
		expect(after?.messages.at(-1)?.variants[0]?.content).toBe("Keep the generated output.");
		database.exec("DROP TRIGGER fail_terminal");
		const generationId = after?.activeGenerations[0]?.generationId;
		if (generationId === undefined) throw new Error("Missing Generation.");
		stopConversationGeneration(module, { conversationId, generationId });
		expect(readTestConversationSnapshot(module, conversationId)?.activeGenerations).toHaveLength(0);
		expect(readTestConversationSnapshot(module, conversationId)?.messages.at(-1)?.variants[0]?.content).toBe("Keep the generated output.");
	});

	test("creates a separate model Message and exposes instruction intent without synthetic history", async () => {
		let received: ModelClientGenerationInput | undefined;
		const before = readTestConversationSnapshot(database, conversationId);
		if (before === undefined) throw new Error("Missing Conversation.");
		await runGenerationLifecycle(database, {connection: null,target: { kind: "continuation" },
			conversationId,
			expectedRevision: before.revision,
			modelClient: createFakeModelClient((input) => {
				received = input;
				return "The next scene begins.";
			}),
		});
		const messages = currentSnapshot().messages;
		expect(messages).toHaveLength(2);
		expect(messages[1]?.author?.participantId).toBe(modelId);
		expect(messages[1]?.historicalContext).toEqual({
			humanParticipantId: humanId,
			modelParticipantId: modelId,
		});
		expect(messages[1]?.variants[0]?.content).toBe("The next scene begins.");
		expect(received?.promptPlan.intent).toEqual({
			type: "continuation",
			strategy: "instruction",
			instruction: "Continue the narrative naturally without repeating the previous text.",
		});
		expect(received?.promptPlan.blocks.filter((block) => block.kind === "history")).toEqual([
			{ kind: "history", speakerName: "Maren", content: "The first scene ends here.", role: "model" },
		]);
	});

	test("continues a reasoning-only terminal Variant without placing reasoning in prompt history", async () => {
		const module = database;
		const before = readTestConversationSnapshot(module, conversationId);
		if (before === undefined) throw new Error("Missing Conversation.");
		const variant = before.messages[0]?.variants[0];
		if (variant === undefined) throw new Error("Missing Variant.");
		executeConversationCommand(module, {
			conversationId,
			expectedRevision: before.revision,
			action: {
				type: "put-data",
				scope: { type: "variant", messageId: before.messages[0]!.id, variantId: variant.id },
				namespace: "generation",
				key: "reasoning",
				value: "Private reasoning.",
			},
		});
		const current = readTestConversationSnapshot(module, conversationId);
		if (current === undefined) throw new Error("Missing Conversation.");
		let received: PromptPlan | undefined;
		await runGenerationLifecycle(database, {connection: null,target: { kind: "continuation" },
			conversationId,
			expectedRevision: current.revision,
			modelClient: createFakeModelClient(({ promptPlan }) => {
				received = promptPlan;
				return "Visible continuation.";
			}),
		});
		expect(currentSnapshot().messages).toHaveLength(2);
		expect(received?.blocks.some((block) => block.content.includes("Private reasoning."))).toBe(false);
	});

	test("uses the current model Control even when the preceding model Message has another author", async () => {
		const module = database;
		const seed = readTestConversationSnapshot(module, conversationId);
		if (seed === undefined) throw new Error("Missing Conversation.");
		const _generated = await generateTerminalTailFixture(database, {connection: null,
			conversationId,
			modelClient: createFakeModelClient(() => "The generated terminal Message."),
		});
		const before = readTestConversationSnapshot(module, conversationId);
		if (before === undefined) throw new Error("Missing Conversation.");
		const withCast = executeConversationCommand(module, {
			conversationId,
			expectedRevision: before.revision,
			action: {
				type: "add-participant",
				definition: definition("New Model"),
			},
		});
		const newModelId = withCast.cast.at(-1)?.id;
		if (newModelId === undefined) throw new Error("Missing new model.");
		const reassigned = executeConversationCommand(module, {
			conversationId,
			expectedRevision: withCast.revision,
			action: { type: "assign-control", seat: "model", participantId: newModelId },
		});
		await runGenerationLifecycle(database, {connection: null,target: { kind: "continuation" },
			conversationId,
			expectedRevision: reassigned.revision,
			modelClient: createFakeModelClient(() => "Authored by the new model."),
		});
		expect(currentSnapshot().messages.at(-1)?.author?.participantId).toBe(newModelId);
	});

	test("rejects non-terminal positions and leaves history unchanged", async () => {
		const module = database;
		const before = readTestConversationSnapshot(module, conversationId);
		if (before === undefined) throw new Error("Missing Conversation.");
		const latest = applyCommand(module, {
			conversationId,
			expectedRevision: before.revision,
			action: {
				type: "create-message",
				timestamp: "2026-08-27T00:01:00Z",
				variantContents: ["A human direction."],
				authorParticipantId: humanId,
			},
		});
		await expect(runGenerationLifecycle(database, {connection: null,target: { kind: "continuation" },
			conversationId,
			expectedRevision: latest.revision,
			modelClient: createFakeModelClient(() => "not called"),
		})).rejects.toThrow();
		expect(readTestConversationSnapshot(module, conversationId)).toEqual(latest);
	});

	test("budget preflight includes the instruction", async () => {
		const module = database;
		const before = readTestConversationSnapshot(module, conversationId);
		if (before === undefined) throw new Error("Missing Conversation.");
		let transcript = "";
		await runGenerationLifecycle(database, {connection: null,target: { kind: "continuation" },
			conversationId,
			expectedRevision: before.revision,
			modelClient: createFakeModelClient(() => "done"),
			tokenEstimator: (value) => {
				transcript = value;
				return 1;
			},
		});
		expect(transcript).toContain("Continue the narrative naturally without repeating the previous text.");
	});

	test("uses Assistant prefill request metadata without mutating either Message", async () => {
		const module = database;
		const before = readTestConversationSnapshot(module, conversationId);
		if (before === undefined) throw new Error("Missing Conversation.");
		const configured = executeConversationCommand(module, {
			conversationId,
			expectedRevision: before.revision,
			action: {
				type: "update-generation-settings",
				settings: {
					modelId: "deepseek-chat",
					temperature: null,
					topP: null,
					frequencyPenalty: null,
					presencePenalty: null,
					contextLimit: 32768,
					responseBudget: 1024,
					safetyAllowance: 500,
					siblingGenerationLimit: 4,
					continuationStrategy: "assistant-prefill",
					continuationInstruction: "This must be ignored.",
					continuationPrefillSuffix: "\n",
					repeatedImagePlacement: "last",
					requestOverrides: {
						"chat-completions": {},
						responses: {},
						"anthropic-messages": {},
					},
				},
			},
		});
		let received: ModelClientGenerationInput | undefined;
		const preview = await createGenerationPreviewAsync(database, {connection: null, conversationId, kind: "continuation" });
		if (preview.capture.target.kind !== "continuation") throw new Error("Expected a Continuation preview.");
		const promptPlan = preview.capture.plan.promptPlan;
		expect(promptPlan.intent).toEqual({
			type: "continuation",
			strategy: "assistant-prefill",
			suffix: "\n",
		});
		expect(promptPlan.blocks.filter((block) => block.kind === "history")).toHaveLength(1);
		await runGenerationLifecycle(database, {connection: null,target: { kind: "continuation" },
			conversationId,
			expectedRevision: configured.revision,
			modelClient: createFakeModelClient((input) => {
				received = input;
				return "A new continuation.";
			}),
		});
		expect(received?.promptPlan.intent).toEqual({
			type: "continuation",
			strategy: "assistant-prefill",
			suffix: "\n",
		});
		// @approved
		//  The assistant prefill is adapter request intent derived from
		// the plan's protected final model entry, not a separately retained capture.
		expect(received?.promptPlan.intent).not.toHaveProperty("instruction");
		expect(currentSnapshot().messages[0]?.variants[0]?.content).toBe("The first scene ends here.");
		expect(currentSnapshot().messages[1]?.variants[0]?.content).toBe("A new continuation.");
	});

	test("retains only the applicable Continuation operand in provenance", async () => {
		// The default instruction strategy: the instruction is used, the Prefill
		// suffix never applies.
		const before = readTestConversationSnapshot(database, conversationId);
		if (before === undefined) throw new Error("Missing Conversation.");
		await runGenerationLifecycle(database, {connection: null,target: { kind: "continuation" },
			conversationId,
			expectedRevision: before.revision,
			modelClient: createFakeModelClient(() => "The next scene begins."),
		});
		const message = currentSnapshot().messages.at(-1);
		const variant = message?.variants[0];
		if (message === undefined || variant === undefined) throw new Error("Variant missing.");
		expect(readVariantDetails(database,
			conversationId,
			message.id,
			variant.id,
		)?.provenance?.generationSettings).toMatchObject({
			continuationStrategy: "instruction",
			continuationInstruction:
				"Continue the narrative naturally without repeating the previous text.",
			continuationPrefillSuffix: null,
			repeatedImagePlacement: "last",
		});
	});

	test("retains only the Prefill suffix for an assistant-prefill Continuation", async () => {
		const module = database;
		const before = readTestConversationSnapshot(module, conversationId);
		if (before === undefined) throw new Error("Missing Conversation.");
		const configured = executeConversationCommand(module, {
			conversationId,
			expectedRevision: before.revision,
			action: {
				type: "update-generation-settings",
				settings: {
					modelId: "deepseek-chat",
					temperature: null,
					topP: null,
					frequencyPenalty: null,
					presencePenalty: null,
					contextLimit: 32768,
					responseBudget: 1024,
					safetyAllowance: 500,
					siblingGenerationLimit: 4,
					continuationStrategy: "assistant-prefill",
					continuationInstruction: "This instruction is not applicable.",
					continuationPrefillSuffix: "\n",
					repeatedImagePlacement: "last",
					requestOverrides: {
						"chat-completions": {},
						responses: {},
						"anthropic-messages": {},
					},
				},
			},
		});
		await runGenerationLifecycle(database, {connection: null,target: { kind: "continuation" },
			conversationId,
			expectedRevision: configured.revision,
			modelClient: createFakeModelClient(() => "A prefilled continuation."),
		});
		const message = currentSnapshot().messages.at(-1);
		const variant = message?.variants[0];
		if (message === undefined || variant === undefined) throw new Error("Variant missing.");
		expect(readVariantDetails(database,
			conversationId,
			message.id,
			variant.id,
		)?.provenance?.generationSettings).toMatchObject({
			continuationStrategy: "assistant-prefill",
			continuationInstruction: null,
			continuationPrefillSuffix: "\n",
			repeatedImagePlacement: "last",
		});
	});

	test("rejects Assistant prefill for reasoning-only preceding Variants", async () => {
		const module = database;
		const before = readTestConversationSnapshot(module, conversationId);
		if (before === undefined) throw new Error("Missing Conversation.");
		const variant = before.messages[0]?.variants[0];
		if (variant === undefined) throw new Error("Missing Variant.");
		const withoutVisibleText = executeConversationCommand(module, {
			conversationId,
			expectedRevision: before.revision,
			action: {
				type: "edit-variant",
				messageId: before.messages[0]!.id,
				variantId: variant.id,
				content: "",
			},
		});
		const withReasoning = executeConversationCommand(module, {
			conversationId,
			expectedRevision: withoutVisibleText.revision,
			action: {
				type: "put-data",
				scope: { type: "variant", messageId: before.messages[0]!.id, variantId: variant.id },
				namespace: "generation",
				key: "reasoning",
				value: "Private reasoning only.",
			},
		});
		const configured = executeConversationCommand(module, {
			conversationId,
			expectedRevision: withReasoning.revision,
			action: {
				type: "update-generation-settings",
				settings: {
					modelId: "deepseek-chat",
					temperature: null,
					topP: null,
					frequencyPenalty: null,
					presencePenalty: null,
					contextLimit: 32768,
					responseBudget: 1024,
					safetyAllowance: 500,
					siblingGenerationLimit: 4,
					continuationStrategy: "assistant-prefill",
					continuationInstruction: "Ignored.",
					continuationPrefillSuffix: "",
					repeatedImagePlacement: "last",
					requestOverrides: {
						"chat-completions": {},
						responses: {},
						"anthropic-messages": {},
					},
				},
			},
		});
		await expect(runGenerationLifecycle(database, {connection: null,target: { kind: "continuation" },
			conversationId,
			expectedRevision: configured.revision,
			modelClient: createFakeModelClient(() => "not called"),
		})).rejects.toMatchObject({
			name: "ContinuationUnavailableError",
			reason: "assistant-prefill-requires-visible-text",
		});
	});
});
