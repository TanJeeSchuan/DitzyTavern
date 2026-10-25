import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createConversationWithHistory, openObservedDatabase } from "../test-fixtures/conversation";
import {
	acceptConversationTailGeneration,
	checkpointConversationGeneration,
	cleanupRetainedGenerationInspections,
	readActiveGenerationDetails,
	resolveConversationGeneration,
	stopConversationGeneration,
} from ".";

const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };

describe("Generation checkpoints", () => {
	let database: Database;
	beforeEach(() => { database = openObservedDatabase(); });
	afterEach(() => database.close());

	const accept = () => {
		const created = createConversationWithHistory(database, {
			name: "Checkpoint Chat",
			participants: [{ definition: { name: "Writer", prompt, openings: [] } }, { definition: { name: "Maren", prompt, openings: [] } }],
			control: { human: 0, model: 1 },
		});
		const accepted = acceptConversationTailGeneration(database, {
			seed: "seed", conversationId: created.id, expectedRevision: created.revision, timestamp: "2026-10-25T00:00:00.000Z",
			humanContent: "Go on.", humanParticipantId: created.cast[0]!.id, modelParticipantId: created.cast[1]!.id, capturedModelName: "Maren",
			promptPlan: { blocks: [{ kind: "instruction", role: "system", content: "Answer." }], warnings: [], images: [] },
			promptInspection: { tokenEstimate: 1, responseBudget: 64, safetyAllowance: 0, contextLimit: 128, totalRequiredTokens: 65, omittedContext: [] },
			promptContext: [{ kind: "message", speakerName: "Writer", content: "Go on.", role: "human" }],
			generationSettings: {}, connection: {},
		});
		const checkpoint = (contentOffset: number, contentDelta: string, reasoningOffset: number, reasoningDelta: string, latestEventId: number) =>
			checkpointConversationGeneration(database, {
				conversationId: created.id, generationId: accepted.generationId, contentOffset, contentDelta, reasoningOffset, reasoningDelta, latestEventId,
			});
		const details = () => readActiveGenerationDetails(database, created.id, accepted.generationId);
		const rows = (table: string) => database.query<{ n: number }, [number]>(`SELECT count(*) n FROM ${table} WHERE generation_id = ?`).get(accepted.generationId)!.n;
		return { conversationId: created.id, generationId: accepted.generationId, checkpoint, details, rows };
	};

	test("deltas assemble into both streams and the latest event position", () => {
		const generation = accept();
		generation.checkpoint(0, "Once ", 0, "Plan", 2);
		generation.checkpoint(5, "upon", 4, "", 5);
		generation.checkpoint(9, " a time.", 4, " more", 9);
		expect(generation.details()?.checkpoint).toMatchObject({ content: "Once upon a time.", reasoning: "Plan more", latestEventId: 9 });
		expect(generation.details()?.promptContext).toEqual([{ kind: "message", speakerName: "Writer", content: "Go on.", role: "human" }]);
	});

	test("a delta that does not continue the stored output is rejected and stores nothing", () => {
		const generation = accept();
		generation.checkpoint(0, "Once ", 0, "", 1);
		expect(() => generation.checkpoint(0, "Once upon", 0, "", 2)).toThrow("does not continue");
		expect(() => generation.checkpoint(9, "gap", 0, "", 3)).toThrow("does not continue");
		expect(generation.details()?.checkpoint).toMatchObject({ content: "Once ", latestEventId: 1 });
	});

	test("deltas end with the Generation and its capture ends with the retained inspection", () => {
		const generation = accept();
		generation.checkpoint(0, "Partial", 0, "", 1);
		stopConversationGeneration(database, { conversationId: generation.conversationId, generationId: generation.generationId });
		expect(generation.rows("generation_checkpoint")).toBe(0);
		expect(generation.details()).toMatchObject({ status: "interrupted", checkpoint: { content: "Partial", latestEventId: 1 } });
		cleanupRetainedGenerationInspections(database, new Date(Date.now() + 24 * 60 * 60 * 1000));
		expect(generation.details()).toBeUndefined();
		expect(generation.rows("generation_capture")).toBe(0);
	});

	test("a discarded target takes its capture with it", () => {
		const generation = accept();
		stopConversationGeneration(database, { conversationId: generation.conversationId, generationId: generation.generationId });
		expect(generation.rows("generation_capture")).toBe(0);
	});

	test("resolution retains the outcome text over the checkpointed text", () => {
		const generation = accept();
		generation.checkpoint(0, "Draft", 0, "", 1);
		resolveConversationGeneration(database, {
			conversationId: generation.conversationId, generationId: generation.generationId, timestamp: "2026-10-25T00:00:01.000Z", content: "Final answer.", reasoning: "Thought.",
		});
		expect(generation.details()?.checkpoint).toMatchObject({ content: "Final answer.", reasoning: "Thought.", latestEventId: 1 });
	});
});
