import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { participantPromptTable, participantTable } from "../database/schema";
import { openInitializedDatabase } from "../database/database";
import {
	createConversationModule,
	ConversationNotPlayableError,
	ConversationNotFoundError,
} from "../conversation";
import type { ParticipantDefinition } from "../conversation";
import {
	PromptBudgetExceededError,
	type PromptPlan,
} from "../prompt-compiler";
import {
	createFakeModelClient,
	type ModelClientGenerationInput,
} from "../model-client";
import {
	generateSiblingVariant,
	sendThroughProvisionalTailGeneration,
} from ".";
import { clearGenerationPreviewRegistry, createGenerationPreview } from "./generation-preview";
import { generateTerminalTailFixture } from "./test-fixtures";
import { applyCommand, requireSnapshot } from "../conversation/test-fixtures";
import { importNativePromptPreset, selectConversationPromptPreset } from "../prompt-preset";
import { attachLorebookToConversation, saveLoreSettings } from "../lorebook/attachments";
import { importNativeLorebook } from "../lorebook/library";

const prompt = (
	overrides: Partial<ParticipantDefinition["prompt"]> = {},
): ParticipantDefinition["prompt"] => ({
	systemInstruction: "Keep the reply literary.",
	identity: "I am {{self}}, speaking to {{other}}.",
	scenario: "The fog closes in on the lantern house.",
	exampleDialogue: "<START>\n{{user}}: Who tends the light?",
	postHistoryInstruction: "End with a question.",
	...overrides,
});

const adHoc = (
	name: string,
	openings: string[] = [],
	promptOverrides: Partial<ParticipantDefinition["prompt"]> = {},
): ParticipantDefinition => ({
	name,
	prompt: prompt(promptOverrides),
	openings,
});

const fakeModelClient = (
    response: (plan: PromptPlan) => string | Promise<string>,
) =>
	createFakeModelClient(({ promptPlan }) => response(promptPlan));

const sendPreview = (
	database: Database,
	conversationId: number,
	options: { content?: string; tokenEstimator?: () => number } = {},
) => {
	const preview = createGenerationPreview(database, {
		conversationId,
		kind: "send",
		content: options.content ?? "Draft",
		tokenEstimator: options.tokenEstimator,
	});
	if (preview.capture.kind !== "send") throw new Error("Expected a Send preview.");
	return preview.capture.capture;
};

const continuationPreview = (database: Database, conversationId: number) => {
	const preview = createGenerationPreview(database, { conversationId, kind: "continuation" });
	if (preview.capture.kind !== "continuation") throw new Error("Expected a Continuation preview.");
	return preview.capture.capture;
};

describe("Generation runtime behavior", () => {
	let database: Database;
	let conversationId: number;
	let humanId: number;
	let modelId: number;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		const snapshot = createConversationModule(database).create({
			name: "Generating Chat",
			participants: [
				{ definition: adHoc("Writer") },
				{ definition: adHoc("Maren Voss", ["The lamp turns above you."]) },
			],
			control: { human: 0, model: 1 },
		});
		conversationId = snapshot.id;
		const human = snapshot.cast[0];
		const model = snapshot.cast[1];
		if (human === undefined || model === undefined) {
			throw new Error("Conversation setup missing Cast Participants.");
		}
		humanId = human.id;
		modelId = model.id;
	});

	afterEach(() => {
		clearGenerationPreviewRegistry();
		database.close();
	});

	test("preview compiles the plan with ordered blocks and participant context", () => {
		const capture = sendPreview(database, conversationId);
		const plan = capture.plan.promptPlan;

		expect(capture.humanParticipant).toEqual({ id: humanId, name: "Writer" });
		expect(capture.author).toEqual({ participantId: modelId, capturedName: "Maren Voss" });
		expect(plan.blocks.map((block) => block.kind)).toEqual([
			"system-instruction",
			"identity",
			"identity",
			"scenario",
			"example-dialogue",
			"history",
			"history",
			"post-history-instruction",
		]);
		// Identities expand owner-relative: self is the Definition owner, and
		// the stored Default recipe presents the human Identity as user and the
		// model Identity as assistant.
		expect(
			plan.blocks.filter((block) => block.kind === "identity"),
		).toEqual([
			{
				kind: "identity",
				role: "human",
				content: "I am Writer, speaking to Maren Voss.",
			},
			{
				kind: "identity",
				role: "model",
				content: "I am Maren Voss, speaking to Writer.",
			},
		]);
		// The greeting is selected history, stamped with the captured name.
		expect(
			plan.blocks.filter((block) => block.kind === "history"),
		).toEqual([
			{
				kind: "history",
				speakerName: "Maren Voss",
				content: "The lamp turns above you.",
				role: "model",
			},
			{
				kind: "history",
				speakerName: "Writer",
				content: "Draft",
				role: "human",
			},
		]);
		// Unknown macros in Example Dialogue surface as warnings.
		expect(plan.warnings).toContainEqual({
			block: "example-dialogue",
			macro: "{{user}}",
		});
		expect(capture.plan.budget.responseBudget).toBe(1_024);
		expect(capture.plan.budget.safetyAllowance).toBe(500);
		expect(capture.plan.budget.fits).toBe(true);
		expect(capture.plan.budget.omittedContext).toEqual([]);
		// Provider vocabulary never leaks into the Prompt Plan.
		expect(JSON.stringify(plan)).not.toContain("assistant");
		expect(JSON.stringify(plan)).not.toContain('"user"');
	});

	test("the terminal fixture creates a Message authored by the model seat at generation start", async () => {
		const expectedPlan = continuationPreview(database, conversationId).plan.promptPlan;
		let receivedPlan: PromptPlan | undefined;
		const committed = await generateTerminalTailFixture(database, {
			conversationId,
			timestamp: "2026-08-20T13:00:00Z",
			modelClient: fakeModelClient((plan) => {
				receivedPlan = plan;
				return "The light understands you.";
			}),
		});

		// The transport receives exactly the canonical Continuation preview plan.
		expect(receivedPlan).toEqual(expectedPlan);

		const message = committed.messages.at(-1);
		expect(message?.author).toEqual({
			participantId: modelId,
			capturedName: "Maren Voss",
			inCast: true,
		});
		expect(message?.historicalContext).toEqual({
			humanParticipantId: humanId,
			modelParticipantId: modelId,
		});
		expect(message?.variants).toEqual([
			expect.objectContaining({
				content: "The light understands you.",
				selected: true,
			}),
		]);
		expect(committed.messages).toHaveLength(2);
		// Acceptance and resolution each advance the revision exactly once.
		expect(committed.revision).toBe(2);
	});

	test("the terminal fixture forwards normalized events and freezes the captured generation input", async () => {
		const receivedEvents: unknown[] = [];
		let receivedInput: ModelClientGenerationInput | undefined;
		const expectedPlan = continuationPreview(database, conversationId).plan.promptPlan;

		const committed = await generateTerminalTailFixture(database, {
			conversationId,
			modelClient: createFakeModelClient((input) => {
				receivedInput = input;
				return [
					{ type: "reasoning", text: "First, " },
					{ type: "content", text: "the answer." },
					{ type: "usage", usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 } },
					{ type: "finished", finishReason: "stop" },
				];
			}),
			onEvent: (event) => {
				receivedEvents.push(event);
			},
		});

		expect(receivedInput?.promptPlan).toEqual(expectedPlan);
		expect(receivedInput?.generationSettings).toMatchObject({
			contextLimit: 32_768,
			responseBudget: 1_024,
		});
		expect(receivedInput?.connection).toBeNull();
		expect(receivedEvents).toEqual([
			{ type: "reasoning", text: "First, " },
			{ type: "content", text: "the answer." },
			{ type: "usage", usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 } },
			{ type: "finished", finishReason: "stop" },
		]);
		expect(committed.messages.at(-1)?.variants[0]?.content).toBe("the answer.");
		expect(committed.messages.at(-1)?.variants[0]?.data).toContainEqual({
			namespace: "generation",
			key: "reasoning",
			value: "First, ",
		});
	});

	test("later Generations include earlier selected Messages in prompt history", async () => {
		const plans: PromptPlan[] = [];
		await generateTerminalTailFixture(database, {
			conversationId,
			timestamp: "2026-08-20T13:00:00Z",
			modelClient: fakeModelClient((plan) => {
				plans.push(plan);
				return "First reply.";
			}),
		});
		await generateTerminalTailFixture(database, {
			conversationId,
			timestamp: "2026-08-20T13:05:00Z",
			modelClient: fakeModelClient((plan) => {
				plans.push(plan);
				return "Second reply.";
			}),
		});

		const history = plans[1]?.blocks.filter((block) => block.kind === "history");
		expect(history?.map((entry) => entry.content)).toEqual([
			"The lamp turns above you.",
			"First reply.",
		]);
		expect(history?.map((entry) => entry.speakerName)).toEqual([
			"Maren Voss",
			"Maren Voss",
		]);
	});

	test("generates through either Control order using identities, not positions", async () => {
		const swapped = createConversationModule(database).create({
			name: "Swapped Chat",
			participants: [
				{ definition: adHoc("Maren Voss", ["Held by the model seat."]) },
				{ definition: adHoc("Writer") },
			],
			control: { human: 1, model: 0 },
		});

		const committed = await generateTerminalTailFixture(database, {
			conversationId: swapped.id,
			timestamp: "2026-08-20T13:00:00Z",
			modelClient: fakeModelClient(() => "The swapped model answers."),
		});
		const message = committed.messages.at(-1);
		expect(message?.author?.participantId).toBe(swapped.cast[0]?.id);
		expect(message?.historicalContext).toEqual({
			humanParticipantId: swapped.cast[1]?.id,
			modelParticipantId: swapped.cast[0]?.id,
		});
	});

	test("rejects unplayable Conversations with a typed result before the transport", async () => {
		const incomplete = createConversationModule(database).create({
			name: "Incomplete Import",
			messages: [
				{
					timestamp: "2026-08-20T10:00:00Z",
					variants: [
						{
							content: "Preserved",
							timestamp: "2026-08-20T10:00:00Z",
							selected: true,
						},
					],
				},
			],
		});

		let contacted = false;
		await expect(
			generateTerminalTailFixture(database, {
				conversationId: incomplete.id,
				modelClient: fakeModelClient(() => {
					contacted = true;
					return "Never reached";
				}),
			}),
		).rejects.toThrow(ConversationNotPlayableError);
		expect(contacted).toBe(false);

		const after = createConversationModule(database).getSnapshot(incomplete.id);
		expect(after?.messages).toHaveLength(1);
		expect(after?.revision).toBe(0);

		expect(() => sendPreview(database, incomplete.id)).toThrow(ConversationNotPlayableError);
	});

	test("missing Conversations fail preview and generation with the typed not-found result", async () => {
		expect(() => sendPreview(database, 424242)).toThrow(
			ConversationNotFoundError,
		);
		await expect(
			generateTerminalTailFixture(database, {
				conversationId: 424242,
				modelClient: fakeModelClient(() => "x"),
			}),
		).rejects.toThrow(ConversationNotFoundError);
	});

	test("a transport failure commits nothing", async () => {
		const snapshot = createConversationModule(database).getSnapshot(conversationId);
		if (snapshot === undefined) throw new Error("Snapshot missing.");

		await expect(
			generateTerminalTailFixture(database, {
				conversationId,
				modelClient: fakeModelClient(() => {
					throw new Error("Transport down.");
				}),
			}),
		).rejects.toThrow("Transport down.");

		const after = createConversationModule(database).getSnapshot(conversationId);
		expect(after?.messages).toEqual(snapshot.messages);
		// Acceptance and terminal removal are both authoritative lifecycle
		// transitions even though no durable Message remains.
		expect(after?.revision).toBe(snapshot.revision + 2);
	});

	test("preserves visible partial work as interrupted when a stream fails", async () => {
		const committed = await generateTerminalTailFixture(database, {
			conversationId,
			timestamp: "2026-08-20T13:10:00Z",
			modelClient: createFakeModelClient(() => [
				{ type: "content", text: "The first half survives." },
				{ type: "failed", kind: "transport", message: "The provider stream failed safely." },
			]),
		});

		const variant = committed.messages.at(-1)?.variants[0];
		expect(variant?.content).toBe("The first half survives.");
		expect(variant?.data).toContainEqual({
			namespace: "generation",
			key: "outcome",
			value: "interrupted",
		});
		expect(variant?.data).toContainEqual({
			namespace: "generation",
			key: "error",
			value: "The provider stream failed safely.",
		});
	});

	test("removes a failed zero-output attempt and keeps the prior selection", async () => {
		const before = createConversationModule(database).getSnapshot(conversationId);
		if (before === undefined) throw new Error("Snapshot missing.");

		await expect(
			generateTerminalTailFixture(database, {
				conversationId,
				modelClient: createFakeModelClient(() => [
					{ type: "failed", kind: "inactivity", message: "The stream became inactive." },
				]),
			}),
		).rejects.toThrow("The stream became inactive.");

		const after = createConversationModule(database).getSnapshot(conversationId);
		expect(after?.messages).toEqual(before.messages);
		// Acceptance and terminal removal are both authoritative lifecycle
		// transitions even though no durable Message remains.
		expect(after?.revision).toBe(before.revision + 2);
	});

	test("treats cancellation as targeted and preserves already received output", async () => {
		const committed = await generateTerminalTailFixture(database, {
			conversationId,
			modelClient: createFakeModelClient(() => [
				{ type: "content", text: "Before cancellation." },
				{ type: "failed", kind: "cancelled", message: "Generation was cancelled." },
			]),
		});

		const variant = committed.messages.at(-1)?.variants[0];
		expect(variant?.content).toBe("Before cancellation.");
		expect(variant?.data).toContainEqual({
			namespace: "generation",
			key: "outcome",
			value: "interrupted",
		});
		expect(variant?.data.some((entry) => entry.key === "error")).toBe(false);
	});

	test("persists reasoning separately, including reasoning-only output", async () => {
		const committed = await generateTerminalTailFixture(database, {
			conversationId,
			modelClient: createFakeModelClient(() => [
				{ type: "reasoning", text: "Private thought, " },
				{ type: "reasoning", text: "kept separately." },
				{ type: "finished", finishReason: "stop" },
			]),
		});

		const variant = committed.messages.at(-1)?.variants[0];
		expect(variant?.content).toBe("");
		expect(variant?.data).toContainEqual({
			namespace: "generation",
			key: "reasoning",
			value: "Private thought, kept separately.",
		});
	});

	test("ignores unrecognized reasoning shapes while visible content continues", async () => {
		const committed = await generateTerminalTailFixture(database, {
			conversationId,
			modelClient: createFakeModelClient(() => [
				{ type: "content", text: "Visible output." },
				{ type: "finished", finishReason: "stop" },
			]),
		});

		const variant = committed.messages.at(-1)?.variants[0];
		expect(variant?.content).toBe("Visible output.");
		expect(variant?.data.some((entry) => entry.key === "reasoning")).toBe(false);
	});

	test("records a length-limited terminal outcome without continuing automatically", async () => {
		const committed = await generateTerminalTailFixture(database, {
			conversationId,
			modelClient: createFakeModelClient(() => [
				{ type: "content", text: "Truncated answer." },
				{ type: "finished", finishReason: "length" },
			]),
		});

		const variant = committed.messages.at(-1)?.variants[0];
		expect(variant?.data).toContainEqual({
			namespace: "generation",
			key: "outcome",
			value: "length-limited",
		});
		expect(variant?.data).toContainEqual({
			namespace: "generation",
			key: "finish",
			value: JSON.stringify({ reason: "length" }),
		});
	});

	test("a mid-flight rename does not rewrite the in-flight generation and the next one uses the new state", async () => {
		let release!: (content: string) => void;
		const pending = new Promise<string>((resolve) => {
			release = resolve;
		});

		const generation = generateTerminalTailFixture(database, {
			conversationId,
			timestamp: "2026-08-20T14:00:00Z",
			modelClient: fakeModelClient(async () => pending),
		});

		// While the transport streams, the model Participant is renamed. The
		// Participant rename command arrives with ticket 04; the concurrent
		// authoritative edit is applied directly to the store here.
		drizzle(database)
			.update(participantTable)
			.set({ name: "Maren Renamed" })
			.where(eq(participantTable.id, modelId))
			.run();

		release("Answered after the rename.");
		const committed = await generation;

		const message = committed.messages.at(-1);
		expect(message?.author).toEqual({
			participantId: modelId,
			capturedName: "Maren Voss",
			inCast: true,
		});
		expect(message?.historicalContext).toEqual({
			humanParticipantId: humanId,
			modelParticipantId: modelId,
		});

		// The next generation compiles from the updated authoritative state.
		const plan: PromptPlan | undefined = await new Promise((resolve) => {
			void generateTerminalTailFixture(database, {
				conversationId,
				timestamp: "2026-08-20T14:05:00Z",
				modelClient: fakeModelClient((receivedPlan) => {
					resolve(receivedPlan);
					return "Answered with the renamed identity.";
				}),
			});
		});
		expect(
			plan?.blocks.find(
				(block) => block.kind === "identity" && block.role === "model",
			)?.content,
		).toBe("I am Maren Renamed, speaking to Writer.");
	});

	test("a mid-flight Definition edit does not rewrite the in-flight generation and the next one compiles the edited Prompt", async () => {
		let release!: (content: string) => void;
		const pending = new Promise<string>((resolve) => {
			release = resolve;
		});

		const generation = generateTerminalTailFixture(database, {
			conversationId,
			timestamp: "2026-08-20T14:00:00Z",
			modelClient: fakeModelClient(async () => pending),
		});

		// The model Prompt is edited while the transport streams (the
		// Participant edit command arrives with ticket 04; the authoritative
		// edit is applied directly to the store here).
		drizzle(database)
			.update(participantPromptTable)
			.set({ identity: "I am the edited Maren." })
			.where(eq(participantPromptTable.participant_id, modelId))
			.run();

		release("Answered after the prompt edit.");
		const committed = await generation;

		const message = committed.messages.at(-1);
		expect(message?.author).toEqual({
			participantId: modelId,
			capturedName: "Maren Voss",
			inCast: true,
		});
		expect(message?.historicalContext).toEqual({
			humanParticipantId: humanId,
			modelParticipantId: modelId,
		});

		// The next generation compiles from the updated authoritative Prompt.
		const capture = sendPreview(database, conversationId);
		expect(
			capture.plan.promptPlan.blocks.find(
				(block) => block.kind === "identity" && block.role === "model",
			)?.content,
		).toBe("I am the edited Maren.");
	});

	test("concurrent edits advancing the revision do not conflict with the generation commit", async () => {
		const module = createConversationModule(database);
		let release!: (content: string) => void;
		const pending = new Promise<string>((resolve) => {
			release = resolve;
		});

		const generation = generateTerminalTailFixture(database, {
			conversationId,
			timestamp: "2026-08-20T14:00:00Z",
			modelClient: fakeModelClient(async () => pending),
		});

		// A concurrent client command lands while the transport streams.
		const midFlight = module.getSnapshot(conversationId);
		if (midFlight === undefined) throw new Error("Snapshot missing.");
		module.execute({
			conversationId,
			expectedRevision: midFlight.revision,
			action: {
				type: "put-data",
				scope: { type: "conversation" },
				namespace: "test",
				key: "mid-flight-edit",
				value: "landed",
			},
		});

		release("Committed after the concurrent edit.");
		const committed = await generation;

		// The edit committed (revision 1), the acceptance reserved the target
		// (revision 2), and the resolution committed on top (revision 3).
		expect(committed.revision).toBe(3);
		expect(committed.messages.at(-1)?.variants[0]?.content).toBe(
			"Committed after the concurrent edit.",
		);
		expect(committed.data).toContainEqual({
			namespace: "test",
			key: "mid-flight-edit",
			value: "landed",
		});
	});

	test("reduces Tail history by whole Messages while protecting the latest human input", async () => {
		const conversation = createConversationModule(database);
		let current = conversation.getSnapshot(conversationId);
		if (current === undefined) throw new Error("Snapshot missing.");
		current = applyCommand(conversation, {
			conversationId,
			expectedRevision: current.revision,
			action: {
				type: "create-message",
				timestamp: "2026-08-20T12:01:00Z",
				variantContents: ["Older model history."],
				authorParticipantId: modelId,
			},
		});
		current = applyCommand(conversation, {
			conversationId,
			expectedRevision: current.revision,
			action: {
				type: "update-generation-settings",
				settings: {
					modelId: "deepseek-chat",
					temperature: null,
					topP: null,
					frequencyPenalty: null,
					presencePenalty: null,
					contextLimit: 102,
					responseBudget: 1,
					safetyAllowance: 0,
					siblingGenerationLimit: 4,
					continuationStrategy: "instruction",
					continuationInstruction: "Continue the narrative naturally without repeating the previous text.",
					continuationPrefillSuffix: "",
					requestOverrides: {
						"chat-completions": {},
						responses: {},
						"anthropic-messages": {},
					},
				},
			},
		});

		const estimates = [200, 100];
		let receivedPlan: PromptPlan | undefined;
		await sendThroughProvisionalTailGeneration(database, {
			conversationId,
			expectedRevision: current.revision,
			content: "Latest human input.",
			modelClient: createFakeModelClient(({ promptPlan }) => {
				receivedPlan = promptPlan;
				return "Budgeted Tail output.";
			}),
			tokenEstimator: () => estimates.shift() ?? 100,
		});

		expect(receivedPlan?.blocks.filter((block) => block.kind === "history")).toEqual([
			{ kind: "history", speakerName: "Maren Voss", content: "Older model history.", role: "model" },
			{ kind: "history", speakerName: "Writer", content: "Latest human input.", role: "human" },
		]);
		expect(requireSnapshot(conversation, conversationId).messages.at(-1)?.variants[0]?.content).toBe("Budgeted Tail output.");
	});

	test("retries a zero-output Send with the same bounded Lore scan window", async () => {
		const conversation = createConversationModule(database);
		const current = requireSnapshot(conversation, conversationId);
		const withRecentHistory = applyCommand(conversation, {
			conversationId,
			expectedRevision: current.revision,
			action: {
				type: "create-message",
				timestamp: "2026-08-20T12:01:00Z",
				variantContents: ["Recent history."],
				authorParticipantId: humanId,
			},
		});
		const preset = importNativePromptPreset(database, {
			name: "Retry Lore",
			slots: [
				{ reference: "history", enabled: true },
				{ reference: "lore", enabled: true, role: "system" },
			],
		});
		selectConversationPromptPreset(drizzle(database), conversationId, preset.id);
		const book = importNativeLorebook(database, {
			name: "Retry Lorebook",
			description: "",
			entries: [{
				title: "Opening memory",
				content: "The opening remains relevant.",
				keywords: ["The lamp turns above you"],
				semanticTriggers: [],
				matchOperator: "or",
				always: false,
				requireAny: [],
				requireAll: [],
				excludeAny: [],
				excludeAll: [],
				caseSensitive: false,
				wholeWord: true,
				keywordMode: "literal",
				regexFlags: "",
				semanticThreshold: null,
				priority: 1,
				enabled: true,
			}],
		});
		attachLorebookToConversation(database, { conversationId, bookId: book.id });
		saveLoreSettings(database, conversationId, { scanDepth: 3, allowance: 2048 });

		const plans: PromptPlan[] = [];
		let attempts = 0;
		await expect(sendThroughProvisionalTailGeneration(database, {
			conversationId,
			expectedRevision: withRecentHistory.revision,
			content: "Please try again.",
			modelClient: createFakeModelClient(({ promptPlan }) => {
				plans.push(promptPlan);
				attempts += 1;
				return attempts === 1
					? [{ type: "failed", kind: "provider", message: "No answer." }]
					: "Recovered answer.";
			}),
		})).rejects.toThrow("No answer.");

		const afterFailure = requireSnapshot(conversation, conversationId);
		await sendThroughProvisionalTailGeneration(database, {
			conversationId,
			expectedRevision: afterFailure.revision,
			content: "Please try again.",
			modelClient: createFakeModelClient(({ promptPlan }) => {
				plans.push(promptPlan);
				return "Recovered answer.";
			}),
		});

		const firstHistory = plans[0]?.blocks.filter((block) => block.kind === "history");
		const retryHistory = plans[1]?.blocks.filter((block) => block.kind === "history");
		expect(retryHistory).toEqual(firstHistory);
		expect(plans[1]?.blocks.filter((block) => block.kind === "lore")).toEqual(
			plans[0]?.blocks.filter((block) => block.kind === "lore"),
		);
		const afterRetry = requireSnapshot(conversation, conversationId);
		expect(afterRetry.messages).toHaveLength(4);
		expect(afterRetry.messages.at(-1)?.variants[0]?.content).toBe("Recovered answer.");
	});

	test("rejects an oversized protected human input before contacting the Model Client", async () => {
		const conversation = createConversationModule(database);
		let current = conversation.getSnapshot(conversationId);
		if (current === undefined) throw new Error("Snapshot missing.");
		current = applyCommand(conversation, {
			conversationId,
			expectedRevision: current.revision,
			action: {
				type: "update-generation-settings",
				settings: {
					modelId: "deepseek-chat",
					temperature: null,
					topP: null,
					frequencyPenalty: null,
					presencePenalty: null,
					contextLimit: 25,
					responseBudget: 1,
					safetyAllowance: 5,
					siblingGenerationLimit: 4,
					continuationStrategy: "instruction",
					continuationInstruction: "Continue the narrative naturally without repeating the previous text.",
					continuationPrefillSuffix: "",
					requestOverrides: {
						"chat-completions": {},
						responses: {},
						"anthropic-messages": {},
					},
				},
			},
		});
		const before = conversation.getSnapshot(conversationId);
		if (before === undefined) throw new Error("Snapshot missing.");
		let contacted = false;

		let failure: PromptBudgetExceededError | undefined;
		try {
			await sendThroughProvisionalTailGeneration(database, {
				conversationId,
				expectedRevision: current.revision,
				content: "Protected human input.",
				modelClient: createFakeModelClient(() => {
					contacted = true;
					return "Must not be contacted.";
				}),
				tokenEstimator: () => 20,
			});
		} catch (error) {
			if (error instanceof PromptBudgetExceededError) failure = error;
			else throw error;
		}
		if (failure === undefined) throw new Error("Expected a PromptBudgetExceededError.");

		expect(contacted).toBe(false);
		expect(conversation.getSnapshot(conversationId)).toEqual(before);
		// The protected element is the Send candidate's own human input.
		expect(failure.result.failure?.reason).toBe("protected-history-too-large");
		expect(failure.breakdown).toMatchObject({
			tokenEstimate: 20,
			responseBudget: 1,
			safetyAllowance: 5,
			contextLimit: 25,
		});
		// Read-only preview of the stored Conversation reports the same
		// impossible budget without contacting anything.
		const capture = sendPreview(database, conversationId, {
			content: "Protected human input.",
			tokenEstimator: () => 20,
		});
		expect(capture.plan.budget.fits).toBe(false);
	});

	test("reduces Sibling history before its target and never prompts on the target or later Messages", async () => {
		const conversation = createConversationModule(database);
		const before = conversation.getSnapshot(conversationId);
		if (before === undefined) throw new Error("Snapshot missing.");
		// The Send composes the production Tail lifecycle: its accepted human
		// Message precedes the generated target the sibling targets.
		const { messageId: targetId } = await sendThroughProvisionalTailGeneration(database, {
			conversationId,
			expectedRevision: before.revision,
			content: "Human context before target.",
			modelClient: fakeModelClient(() => "Target model output."),
		});
		let current = conversation.getSnapshot(conversationId);
		if (current === undefined) throw new Error("Snapshot missing.");
		current = applyCommand(conversation, {
			conversationId,
			expectedRevision: current.revision,
			action: {
				type: "create-message",
				timestamp: "2026-08-20T12:03:00Z",
				variantContents: ["Later history must be excluded."],
				authorParticipantId: humanId,
			},
		});
		current = applyCommand(conversation, {
			conversationId,
			expectedRevision: current.revision,
			action: {
				type: "update-generation-settings",
				settings: {
					modelId: "deepseek-chat",
					temperature: null,
					topP: null,
					frequencyPenalty: null,
					presencePenalty: null,
					contextLimit: 102,
					responseBudget: 1,
					safetyAllowance: 0,
					siblingGenerationLimit: 4,
					continuationStrategy: "instruction",
					continuationInstruction: "Continue the narrative naturally without repeating the previous text.",
					continuationPrefillSuffix: "",
					requestOverrides: {
						"chat-completions": {},
						responses: {},
						"anthropic-messages": {},
					},
				},
			},
		});

		let receivedPlan: PromptPlan | undefined;
		const estimates = [200, 100];
		await generateSiblingVariant(database, {
			conversationId,
			messageId: targetId,
			modelClient: createFakeModelClient(({ promptPlan }) => {
				receivedPlan = promptPlan;
				return "Budgeted sibling output.";
			}),
			tokenEstimator: () => estimates.shift() ?? 100,
		});

		expect(receivedPlan?.blocks.filter((block) => block.kind === "history")).toEqual([
			{ kind: "history", speakerName: "Writer", content: "Human context before target.", role: "human" },
		]);
		const siblingTarget = requireSnapshot(conversation, conversationId).messages.find((message) => message.id === targetId);
		expect(siblingTarget?.variants.at(-1)?.content).toBe("Budgeted sibling output.");
	});

});

describe("Prompt Comments", () => {
	let database: Database;
	let conversationId: number;

	// A comment body may span lines and may contain macro delimiters, so this
	// Definition puts one of each in a prompt field and one in an opening, each
	// enclosing a macro that would otherwise expand or warn.
	const inlineComment = "{{// tone note: mention {{lighthouse}} later }}";
	const multilineComment =
		"{{// draft notes:\n- keep the lantern lit\n- the {{unfinished}} idea\n}}";
	const openingComment = "{{// greet warmly, never as {{other}} }}";

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		conversationId = createConversationModule(database).create({
			name: "Annotated Chat",
			participants: [
				{ definition: adHoc("Writer") },
				{
					definition: adHoc(
						"Maren Voss",
						[`The lamp turns above you.${openingComment}`],
						{
							systemInstruction: `Keep it terse. ${inlineComment}`,
							scenario: `The fog closes in.\n${multilineComment}\nWind rises.`,
							postHistoryInstruction: inlineComment,
						},
					),
				},
			],
			control: { human: 0, model: 1 },
		}).id;
	});

	afterEach(() => {
		database.close();
	});

	test("preview renders authored text without its comments and without warning about their contents", () => {
		const capture = sendPreview(database, conversationId);
		const content = (kind: string) =>
			capture.plan.promptPlan.blocks.find((block) => block.kind === kind)?.content;

		expect(content("system-instruction")).toBe("Keep it terse. ");
		expect(content("scenario")).toBe("The fog closes in.\n\nWind rises.");
		// The opening became the greeting Message at creation, already stripped.
		expect(content("history")).toBe("The lamp turns above you.");
		// A channel holding nothing but a comment renders empty and is omitted.
		expect(content("post-history-instruction")).toBeUndefined();

		// Macros outside comments still resolve owner-relative, and only the
		// ordinary unknown macro in Example Dialogue warns: the unknown macros
		// enclosed by the two comments neither expanded nor warned.
		expect(
			capture.plan.promptPlan.blocks.find(
				(block) => block.kind === "identity" && block.role === "model",
			)?.content,
		).toBe("I am Maren Voss, speaking to Writer.");
		expect(capture.plan.promptPlan.warnings).toEqual([
			{ block: "example-dialogue", macro: "{{user}}" },
		]);
	});

	test("comments survive in storage while the model request omits them", async () => {
		let receivedPlan: PromptPlan | undefined;
		await generateTerminalTailFixture(database, {
			conversationId,
			timestamp: "2026-08-20T13:00:00Z",
			modelClient: fakeModelClient((plan) => {
				receivedPlan = plan;
				return "The light understands you.";
			}),
		});

		// Nothing the transport receives carries comment text — and so nothing
		// budgeting measures does either, since the budget reads this same plan.
		expect(JSON.stringify(receivedPlan)).not.toContain("{{//");

		const model = requireSnapshot(
			createConversationModule(database),
			conversationId,
		).cast[1];
		expect(model?.prompt.systemInstruction).toBe(`Keep it terse. ${inlineComment}`);
		expect(model?.prompt.scenario).toBe(
			`The fog closes in.\n${multilineComment}\nWind rises.`,
		);
		expect(model?.openings).toEqual([`The lamp turns above you.${openingComment}`]);
	});
});
