import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { participantPromptTable, participantTable } from "../database/schema";
import { openDatabase } from "../database/database";
import {
	createConversationModule,
	ConversationNotPlayableError,
	ConversationNotFoundError,
} from "../conversation";
import type { ParticipantDefinition } from "../conversation";
import {
	createTokenEstimator,
	PromptBudgetExceededError,
	type PromptPlan,
} from "../prompt-compiler";
import {
	createFakeModelClient,
	type ModelClientGenerationInput,
} from "../model-client";
import { createConnectionSettingsModule } from "../connection-settings";
import {
	generateSiblingVariant,
	inspectGenerationPrompt,
} from ".";
import { generateTerminalTailFixture } from "./generate";

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
	openings: readonly string[] = [],
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

describe("Generation capture and terminal fixture support", () => {
	let database: Database;
	let conversationId: number;
	let humanId: number;
	let modelId: number;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
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
		database.close();
	});

	test("inspection compiles the plan with ordered blocks and participant context", () => {
		const inspection = inspectGenerationPrompt(database, conversationId);

		expect(inspection.playable).toBe(true);
		expect(inspection.humanParticipant).toEqual({ id: humanId, name: "Writer" });
		expect(inspection.modelParticipant).toEqual({ id: modelId, name: "Maren Voss" });
		expect(inspection.plan?.blocks.map((block) => block.kind)).toEqual([
			"system-instruction",
			"identity",
			"identity",
			"scenario",
			"example-dialogue",
			"history",
			"post-history-instruction",
		]);
		// Identities expand owner-relative: self is the Definition owner.
		expect(
			inspection.plan?.blocks.filter((block) => block.kind === "identity"),
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
			inspection.plan?.blocks.filter((block) => block.kind === "history"),
		).toEqual([
			{
				kind: "history",
				speakerName: "Maren Voss",
				content: "The lamp turns above you.",
			},
		]);
		// Unknown macros in Example Dialogue surface as warnings.
		expect(inspection.plan?.warnings).toContainEqual({
			block: "example-dialogue",
			macro: "{{user}}",
		});
		expect(inspection.responseBudget).toBe(1_024);
		expect(inspection.safetyAllowance).toBe(500);
		expect(inspection.tokenEstimateIsApproximate).toBe(true);
		expect(inspection.budgetFits).toBe(true);
		expect(inspection.omittedHistory).toEqual([]);
		// Provider vocabulary never leaks into the inspection.
		expect(JSON.stringify(inspection)).not.toContain("assistant");
		expect(JSON.stringify(inspection)).not.toContain('"user"');
	});

	test("the terminal fixture creates a Message authored by the model seat at generation start", async () => {
		const expectedPlan = inspectGenerationPrompt(database, conversationId).plan;
		if (expectedPlan === null) {
			throw new Error("Expected a compiled plan for the playable Conversation.");
		}
		let receivedPlan: PromptPlan | undefined;
		const committed = await generateTerminalTailFixture(database, {
			conversationId,
			timestamp: "2026-08-20T13:00:00Z",
			modelClient: fakeModelClient((plan) => {
				receivedPlan = plan;
				return "The light understands you.";
			}),
		});

		// The transport received exactly the plan inspection would compile.
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
		expect(committed.revision).toBe(1);
	});

	test("the terminal fixture forwards normalized events and freezes the captured generation input", async () => {
		const receivedEvents: unknown[] = [];
		let receivedInput: ModelClientGenerationInput | undefined;
		const expectedPlan = inspectGenerationPrompt(database, conversationId).plan;
		if (expectedPlan === null) {
			throw new Error("Expected a compiled plan for the playable Conversation.");
		}

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

		// Inspection reports the same unplayable state without a plan.
		const inspection = inspectGenerationPrompt(database, incomplete.id);
		expect(inspection.playable).toBe(false);
		expect(inspection.plan).toBeNull();
		expect(inspection.humanParticipant).toBeNull();
		expect(inspection.modelParticipant).toBeNull();
	});

	test("missing Conversations fail inspection and generation with the typed not-found result", async () => {
		expect(() => inspectGenerationPrompt(database, 424242)).toThrow(
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
		expect(after?.revision).toBe(snapshot.revision);
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
		expect(after?.revision).toBe(before.revision);
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
		const inspection = inspectGenerationPrompt(database, conversationId);
		expect(
			inspection.plan?.blocks.find(
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

		// The edit committed (revision 1) and the generation committed on top.
		expect(committed.revision).toBe(2);
		expect(committed.messages.at(-1)?.variants[0]?.content).toBe(
			"Committed after the concurrent edit.",
		);
		expect(committed.data).toContainEqual({
			namespace: "test",
			key: "mid-flight-edit",
			value: "landed",
		});
	});

	test("captures effective settings and safe Profile provenance before a streamed request", async () => {
		const key = new Uint8Array(32).fill(19);
		const settingsModule = createConnectionSettingsModule(database, { masterKey: key });
		const profile = {
			displayName: "DeepSeek",
			apiFormat: "chat-completions" as const,
			requestUrl: "https://api.deepseek.com/",
			modelsUrl: "https://api.deepseek.com/models",
			modelBackend: "automatic" as const,
			adapter: "deepseek" as const,
			outputTokenRepresentation: "automatic" as const,
			timeoutMs: 120_000,
			pinnedModels: ["custom-before-discovery"],
		};
		const created = settingsModule.createProfile({
			expectedRevision: 0,
			profile,
			credential: "credential-never-stored-in-provenance",
		});
		const conversation = createConversationModule(database);
		const updatedConversation = conversation.execute({
			conversationId,
			expectedRevision: 0,
			action: {
				type: "update-generation-settings",
				settings: {
					modelId: "custom-before-discovery",
					temperature: 0.4,
					topP: null,
					frequencyPenalty: null,
					presencePenalty: null,
					contextLimit: 8192,
					responseBudget: 128,
					requestOverrides: {
						"chat-completions": { response_format: { type: "text" } },
						responses: {},
						"anthropic-messages": {},
					},
					},
			},
		});
		expect(conversation.getGenerationSettings(conversationId)?.modelId).toBe(
			"custom-before-discovery",
		);

		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		let receivedInput: { modelId?: string; generationSettings?: unknown } | undefined;
		const generation = generateTerminalTailFixture(database, {
			conversationId,
			connectionSettings: { masterKey: key },
			modelClient: {
				async *generate(input) {
					receivedInput = input;
					await pending;
					yield { type: "content", text: "Streamed response." };
					yield { type: "finished", finishReason: "stop" };
				},
			},
		});

		// A Profile edit during transport is authoritative for the next
		// Generation, never for the already captured one.
		const profileId = created.activeProfileId;
		if (profileId === null) throw new Error("Profile activation missing.");
		settingsModule.applyProfile({
			expectedRevision: created.revision,
			profileId,
			profile: { ...profile, displayName: "Edited after start" },
		});
		release();
		const committed = await generation;
		expect(receivedInput?.modelId).toBe("custom-before-discovery");
		expect(receivedInput?.generationSettings).toMatchObject({
		responseBudget: 128,
		contextLimit: 8192,
	});
		const variant = committed.messages.at(-1)?.variants.at(-1);
		const provenance = variant?.data.find(
			(entry) => entry.namespace === "generation" && entry.key === "provenance",
		);
		if (provenance === undefined) throw new Error("Generation provenance missing.");
		// SAFETY: the provenance value was written by the workflow immediately
		// above and this test reads only its safe identity and settings fields.
		const parsed = JSON.parse(provenance.value) as {
			connectionProfileId: number;
			connectionSettingsRevision: number;
			modelBackend: string;
			adapter: string;
			modelId: string;
			generationSettings: { responseBudget: number };
		};
		expect(parsed).toMatchObject({
			connectionProfileId: created.activeProfileId,
			connectionSettingsRevision: created.revision,
			modelBackend: "ai-sdk",
			adapter: "deepseek",
			modelId: "custom-before-discovery",
			generationSettings: { responseBudget: 128 },
		});
		expect(provenance.value).not.toContain("credential-never-stored-in-provenance");
		expect(provenance.value).not.toContain("api.deepseek.com");
		expect(updatedConversation.revision).toBe(1);
	});

	test("stores independent safe settings provenance for sibling Variants", async () => {
		const conversation = createConversationModule(database);
		conversation.execute({
			conversationId,
			expectedRevision: 0,
			action: {
				type: "update-generation-settings",
				settings: {
					modelId: "first-model",
					temperature: null,
					topP: null,
					frequencyPenalty: null,
					presencePenalty: null,
					contextLimit: 4096,
					responseBudget: 64,
					requestOverrides: {
						"chat-completions": {},
						responses: {},
						"anthropic-messages": {},
					},
				},
			},
		});
		const first = await generateTerminalTailFixture(database, {
			conversationId,
			modelClient: fakeModelClient(() => "first generation"),
		});
		const targetId = first.messages.at(-1)?.id;
		if (targetId === undefined) throw new Error("Expected a generated Message.");
		const secondSettings = conversation.execute({
			conversationId,
			expectedRevision: first.revision,
			action: {
				type: "update-generation-settings",
				settings: {
					modelId: "second-model",
					temperature: null,
					topP: null,
					frequencyPenalty: null,
					presencePenalty: null,
					contextLimit: 2048,
					responseBudget: 128,
					requestOverrides: {
						"chat-completions": {},
						responses: {},
						"anthropic-messages": {},
					},
				},
			},
		});
		const sibling = await generateSiblingVariant(database, {
			conversationId,
			messageId: targetId,
			modelClient: fakeModelClient(() => "sibling generation"),
		});
		const target = sibling.messages.find((message) => message.id === targetId);
		if (target === undefined) throw new Error("Target Message disappeared.");
		const provenance = target.variants.map((variant) => {
			const entry = variant.data.find((item) => item.key === "provenance");
			if (entry === undefined) throw new Error("Sibling provenance missing.");
			// SAFETY: both entries were written by the generation workflow and this
			// test reads only the captured model id.
			return (JSON.parse(entry.value) as { modelId: string }).modelId;
		});
		expect(provenance).toEqual([
			"first-model",
			"second-model",
		]);
		expect(secondSettings.revision).toBe(3);
	});

	test("reduces Tail history by whole Messages while protecting the latest human input", async () => {
		const conversation = createConversationModule(database);
		let current = conversation.getSnapshot(conversationId);
		if (current === undefined) throw new Error("Snapshot missing.");
		current = conversation.execute({
			conversationId,
			expectedRevision: current.revision,
			action: {
				type: "create-message",
				timestamp: "2026-08-20T12:01:00Z",
				variantContents: ["Older model history."],
				authorParticipantId: modelId,
			},
		});
		current = conversation.execute({
			conversationId,
			expectedRevision: current.revision,
			action: {
				type: "create-message",
				timestamp: "2026-08-20T12:02:00Z",
				variantContents: ["Latest human input."],
				authorParticipantId: humanId,
			},
		});
		current = conversation.execute({
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
		const committed = await generateTerminalTailFixture(database, {
			conversationId,
			modelClient: createFakeModelClient(({ promptPlan }) => {
				receivedPlan = promptPlan;
				return "Budgeted Tail output.";
			}),
			tokenEstimator: createTokenEstimator(() => estimates.shift() ?? 100),
		});

		expect(receivedPlan?.blocks.filter((block) => block.kind === "history")).toEqual([
			{ kind: "history", speakerName: "Maren Voss", content: "Older model history." },
			{ kind: "history", speakerName: "Writer", content: "Latest human input." },
		]);
		expect(committed.messages.at(-1)?.variants[0]?.content).toBe("Budgeted Tail output.");
	});

	test("rejects an oversized protected human input before contacting the Model Client", async () => {
		const conversation = createConversationModule(database);
		let current = conversation.getSnapshot(conversationId);
		if (current === undefined) throw new Error("Snapshot missing.");
		current = conversation.execute({
			conversationId,
			expectedRevision: current.revision,
			action: {
				type: "create-message",
				timestamp: "2026-08-20T12:04:00Z",
				variantContents: ["Protected human input."],
				authorParticipantId: humanId,
			},
		});
		current = conversation.execute({
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

		await expect(generateTerminalTailFixture(database, {
			conversationId,
			modelClient: createFakeModelClient(() => {
				contacted = true;
				return "Must not be contacted.";
			}),
			tokenEstimator: createTokenEstimator(() => 20),
		})).rejects.toBeInstanceOf(PromptBudgetExceededError);

		expect(contacted).toBe(false);
		expect(conversation.getSnapshot(conversationId)).toEqual(before);
		const inspection = inspectGenerationPrompt(database, conversationId, {
			tokenEstimator: createTokenEstimator(() => 20),
		});
		expect(inspection.budgetFits).toBe(false);
		expect(inspection.budgetFailure?.reason).toBe("protected-history-too-large");
		expect(inspection.budgetFailure?.breakdown).toMatchObject({
			tokenEstimate: 20,
			responseBudget: 1,
			safetyAllowance: 5,
			contextLimit: 25,
		});
	});

	test("reduces Sibling history before its target and never prompts on the target or later Messages", async () => {
		const conversation = createConversationModule(database);
		let current = conversation.getSnapshot(conversationId);
		if (current === undefined) throw new Error("Snapshot missing.");
		current = conversation.execute({
			conversationId,
			expectedRevision: current.revision,
			action: {
				type: "create-message",
				timestamp: "2026-08-20T12:01:00Z",
				variantContents: ["Human context before target."],
				authorParticipantId: humanId,
			},
		});
		const target = await generateTerminalTailFixture(database, {
			conversationId,
			modelClient: fakeModelClient(() => "Target model output."),
		});
		const targetId = target.messages.at(-1)?.id;
		if (targetId === undefined) throw new Error("Target Message missing.");
		current = conversation.getSnapshot(conversationId);
		if (current === undefined) throw new Error("Snapshot missing.");
		current = conversation.execute({
			conversationId,
			expectedRevision: current.revision,
			action: {
				type: "create-message",
				timestamp: "2026-08-20T12:03:00Z",
				variantContents: ["Later history must be excluded."],
				authorParticipantId: humanId,
			},
		});
		current = conversation.execute({
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
		const sibling = await generateSiblingVariant(database, {
			conversationId,
			messageId: targetId,
			modelClient: createFakeModelClient(({ promptPlan }) => {
				receivedPlan = promptPlan;
				return "Budgeted sibling output.";
			}),
			tokenEstimator: createTokenEstimator(() => estimates.shift() ?? 100),
		});

		expect(receivedPlan?.blocks.filter((block) => block.kind === "history")).toEqual([
			{ kind: "history", speakerName: "Writer", content: "Human context before target." },
		]);
		const siblingTarget = sibling.messages.find((message) => message.id === targetId);
		expect(siblingTarget?.variants.at(-1)?.content).toBe("Budgeted sibling output.");
	});
});
