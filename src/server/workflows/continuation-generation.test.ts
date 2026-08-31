import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createConversationModule } from "../conversation";
import type { ParticipantDefinition } from "../conversation";
import { openDatabase } from "../database/database";
import { createFakeModelClient, type ModelClientGenerationInput } from "../model-client";
import { createTokenEstimator, type PromptPlan } from "../prompt-compiler";
import { continueGeneration, inspectGenerationPrompt } from ".";
import { generateTerminalTailFixture } from "./generate";

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
		database = openDatabase({ path: ":memory:" });
		const snapshot = createConversationModule(database).create({
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

	afterEach(() => database.close());

	test("creates a separate model Message and exposes instruction intent without synthetic history", async () => {
		let received: ModelClientGenerationInput | undefined;
		const before = createConversationModule(database).getSnapshot(conversationId);
		if (before === undefined) throw new Error("Missing Conversation.");
		const result = await continueGeneration(database, {
			conversationId,
			expectedRevision: before.revision,
			modelClient: createFakeModelClient((input) => {
				received = input;
				return "The next scene begins.";
			}),
		});
		const messages = result.conversation.messages;
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
			{ kind: "history", speakerName: "Maren", content: "The first scene ends here." },
		]);
	});

	test("continues a reasoning-only terminal Variant without placing reasoning in prompt history", async () => {
		const module = createConversationModule(database);
		const before = module.getSnapshot(conversationId);
		if (before === undefined) throw new Error("Missing Conversation.");
		const variant = before.messages[0]?.variants[0];
		if (variant === undefined) throw new Error("Missing Variant.");
		module.execute({
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
		const current = module.getSnapshot(conversationId);
		if (current === undefined) throw new Error("Missing Conversation.");
		let received: PromptPlan | undefined;
		const result = await continueGeneration(database, {
			conversationId,
			expectedRevision: current.revision,
			modelClient: createFakeModelClient(({ promptPlan }) => {
				received = promptPlan;
				return "Visible continuation.";
			}),
		});
		expect(result.conversation.messages).toHaveLength(2);
		expect(received?.blocks.some((block) => block.content.includes("Private reasoning."))).toBe(false);
	});

	test("uses the current model Control even when the preceding model Message has another author", async () => {
		const module = createConversationModule(database);
		const seed = module.getSnapshot(conversationId);
		if (seed === undefined) throw new Error("Missing Conversation.");
		const _generated = await generateTerminalTailFixture(database, {
			conversationId,
			modelClient: createFakeModelClient(() => "The generated terminal Message."),
		});
		const before = module.getSnapshot(conversationId);
		if (before === undefined) throw new Error("Missing Conversation.");
		const withCast = module.execute({
			conversationId,
			expectedRevision: before.revision,
			action: {
				type: "add-participant",
				definition: definition("New Model"),
			},
		});
		const newModelId = withCast.cast.at(-1)?.id;
		if (newModelId === undefined) throw new Error("Missing new model.");
		const reassigned = module.execute({
			conversationId,
			expectedRevision: withCast.revision,
			action: { type: "assign-control", seat: "model", participantId: newModelId },
		});
		const result = await continueGeneration(database, {
			conversationId,
			expectedRevision: reassigned.revision,
			modelClient: createFakeModelClient(() => "Authored by the new model."),
		});
		expect(result.conversation.messages.at(-1)?.author?.participantId).toBe(newModelId);
	});

	test("rejects non-terminal positions and leaves history unchanged", async () => {
		const module = createConversationModule(database);
		const before = module.getSnapshot(conversationId);
		if (before === undefined) throw new Error("Missing Conversation.");
		const latest = module.execute({
			conversationId,
			expectedRevision: before.revision,
			action: {
				type: "create-message",
				timestamp: "2026-08-27T00:01:00Z",
				variantContents: ["A human direction."],
				authorParticipantId: humanId,
			},
		});
		await expect(continueGeneration(database, {
			conversationId,
			expectedRevision: latest.revision,
			modelClient: createFakeModelClient(() => "not called"),
		})).rejects.toThrow();
		expect(module.getSnapshot(conversationId)).toEqual(latest);
	});

	test("budget preflight includes the instruction", async () => {
		const module = createConversationModule(database);
		const before = module.getSnapshot(conversationId);
		if (before === undefined) throw new Error("Missing Conversation.");
		let transcript = "";
		await continueGeneration(database, {
			conversationId,
			expectedRevision: before.revision,
			modelClient: createFakeModelClient(() => "done"),
			tokenEstimator: createTokenEstimator((value) => {
				transcript = value;
				return 1;
			}),
		});
		expect(transcript).toContain("Continue the narrative naturally without repeating the previous text.");
	});

	test("uses Assistant prefill request metadata without mutating either Message", async () => {
		const module = createConversationModule(database);
		const before = module.getSnapshot(conversationId);
		if (before === undefined) throw new Error("Missing Conversation.");
		const configured = module.execute({
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
					continuationStrategy: "assistant-prefill",
					continuationInstruction: "This must be ignored.",
					continuationPrefillSuffix: "\n",
					requestOverrides: {
						"chat-completions": {},
						responses: {},
						"anthropic-messages": {},
					},
				},
			},
		});
		let received: ModelClientGenerationInput | undefined;
		const inspection = inspectGenerationPrompt(database, conversationId);
		expect(inspection.continuationIntent).toEqual({
			type: "continuation",
			strategy: "assistant-prefill",
			suffix: "\n",
		});
		expect(inspection.plan?.intent).toBeUndefined();
		expect(inspection.plan?.blocks.filter((block) => block.kind === "history")).toHaveLength(1);
		const result = await continueGeneration(database, {
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
		expect(received?.assistantPrefill).toEqual({
			prefix: "The first scene ends here.",
			suffix: "\n",
		});
		expect(received?.promptPlan.intent).not.toHaveProperty("instruction");
		expect(result.conversation.messages[0]?.variants[0]?.content).toBe("The first scene ends here.");
		expect(result.conversation.messages[1]?.variants[0]?.content).toBe("A new continuation.");
	});

	test("retains only the applicable Continuation operand in provenance", async () => {
		// The default instruction strategy: the instruction is used, the Prefill
		// suffix never applies.
		const before = createConversationModule(database).getSnapshot(conversationId);
		if (before === undefined) throw new Error("Missing Conversation.");
		const result = await continueGeneration(database, {
			conversationId,
			expectedRevision: before.revision,
			modelClient: createFakeModelClient(() => "The next scene begins."),
		});
		const message = result.conversation.messages.at(-1);
		const variant = message?.variants[0];
		if (message === undefined || variant === undefined) throw new Error("Variant missing.");
		expect(createConversationModule(database).readVariantDetails(
			conversationId,
			message.id,
			variant.id,
		)?.provenance?.generationSettings).toMatchObject({
			continuationStrategy: "instruction",
			continuationInstruction:
				"Continue the narrative naturally without repeating the previous text.",
			continuationPrefillSuffix: null,
		});
	});

	test("retains only the Prefill suffix for an assistant-prefill Continuation", async () => {
		const module = createConversationModule(database);
		const before = module.getSnapshot(conversationId);
		if (before === undefined) throw new Error("Missing Conversation.");
		const configured = module.execute({
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
					continuationStrategy: "assistant-prefill",
					continuationInstruction: "This instruction is not applicable.",
					continuationPrefillSuffix: "\n",
					requestOverrides: {
						"chat-completions": {},
						responses: {},
						"anthropic-messages": {},
					},
				},
			},
		});
		const result = await continueGeneration(database, {
			conversationId,
			expectedRevision: configured.revision,
			modelClient: createFakeModelClient(() => "A prefilled continuation."),
		});
		const message = result.conversation.messages.at(-1);
		const variant = message?.variants[0];
		if (message === undefined || variant === undefined) throw new Error("Variant missing.");
		expect(createConversationModule(database).readVariantDetails(
			conversationId,
			message.id,
			variant.id,
		)?.provenance?.generationSettings).toMatchObject({
			continuationStrategy: "assistant-prefill",
			continuationInstruction: null,
			continuationPrefillSuffix: "\n",
		});
	});

	test("rejects Assistant prefill for reasoning-only preceding Variants", async () => {
		const module = createConversationModule(database);
		const before = module.getSnapshot(conversationId);
		if (before === undefined) throw new Error("Missing Conversation.");
		const variant = before.messages[0]?.variants[0];
		if (variant === undefined) throw new Error("Missing Variant.");
		const withoutVisibleText = module.execute({
			conversationId,
			expectedRevision: before.revision,
			action: {
				type: "edit-variant",
				messageId: before.messages[0]!.id,
				variantId: variant.id,
				content: "",
			},
		});
		const withReasoning = module.execute({
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
		const configured = module.execute({
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
					continuationStrategy: "assistant-prefill",
					continuationInstruction: "Ignored.",
					continuationPrefillSuffix: "",
					requestOverrides: {
						"chat-completions": {},
						responses: {},
						"anthropic-messages": {},
					},
				},
			},
		});
		await expect(continueGeneration(database, {
			conversationId,
			expectedRevision: configured.revision,
			modelClient: createFakeModelClient(() => "not called"),
		})).rejects.toMatchObject({
			name: "ContinuationUnavailableError",
			reason: "assistant-prefill-requires-visible-text",
		});
	});
});
