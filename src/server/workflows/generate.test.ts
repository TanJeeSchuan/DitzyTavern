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
import type { PromptPlan } from "../prompt-compiler";
import { generateReply, inspectGenerationPrompt } from ".";

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

describe("Current Generate workflow", () => {
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
		// Provider vocabulary never leaks into the inspection.
		expect(JSON.stringify(inspection)).not.toContain("assistant");
		expect(JSON.stringify(inspection)).not.toContain('"user"');
	});

	test("a current Generate creates a Message authored by the model seat at generation start", async () => {
		const expectedPlan = inspectGenerationPrompt(database, conversationId).plan;
		if (expectedPlan === null) {
			throw new Error("Expected a compiled plan for the playable Conversation.");
		}
		let receivedPlan: PromptPlan | undefined;
		const committed = await generateReply(database, {
			conversationId,
			timestamp: "2026-08-20T13:00:00Z",
			generate: (plan) => {
				receivedPlan = plan;
				return "The light understands you.";
			},
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

	test("later Generations include earlier selected Messages in prompt history", async () => {
		const plans: PromptPlan[] = [];
		await generateReply(database, {
			conversationId,
			timestamp: "2026-08-20T13:00:00Z",
			generate: (plan) => {
				plans.push(plan);
				return "First reply.";
			},
		});
		await generateReply(database, {
			conversationId,
			timestamp: "2026-08-20T13:05:00Z",
			generate: (plan) => {
				plans.push(plan);
				return "Second reply.";
			},
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

		const committed = await generateReply(database, {
			conversationId: swapped.id,
			timestamp: "2026-08-20T13:00:00Z",
			generate: () => "The swapped model answers.",
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
			generateReply(database, {
				conversationId: incomplete.id,
				generate: () => {
					contacted = true;
					return "Never reached";
				},
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
			generateReply(database, {
				conversationId: 424242,
				generate: () => "x",
			}),
		).rejects.toThrow(ConversationNotFoundError);
	});

	test("a transport failure commits nothing", async () => {
		const snapshot = createConversationModule(database).getSnapshot(conversationId);
		if (snapshot === undefined) throw new Error("Snapshot missing.");

		await expect(
			generateReply(database, {
				conversationId,
				generate: () => {
					throw new Error("Transport down.");
				},
			}),
		).rejects.toThrow("Transport down.");

		const after = createConversationModule(database).getSnapshot(conversationId);
		expect(after?.messages).toEqual(snapshot.messages);
		expect(after?.revision).toBe(snapshot.revision);
	});

	test("a mid-flight rename does not rewrite the in-flight generation and the next one uses the new state", async () => {
		let release!: (content: string) => void;
		const pending = new Promise<string>((resolve) => {
			release = resolve;
		});

		const generation = generateReply(database, {
			conversationId,
			timestamp: "2026-08-20T14:00:00Z",
			generate: async () => pending,
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
			void generateReply(database, {
				conversationId,
				timestamp: "2026-08-20T14:05:00Z",
				generate: (receivedPlan) => {
					resolve(receivedPlan);
					return "Answered with the renamed identity.";
				},
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

		const generation = generateReply(database, {
			conversationId,
			timestamp: "2026-08-20T14:00:00Z",
			generate: async () => pending,
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

		const generation = generateReply(database, {
			conversationId,
			timestamp: "2026-08-20T14:00:00Z",
			generate: async () => pending,
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
});