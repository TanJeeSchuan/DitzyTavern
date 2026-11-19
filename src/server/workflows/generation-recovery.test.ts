import { createConversationWithHistory, shortReplyPrompt, participantSeed, checkpointFromStart } from "../test-fixtures/conversation";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { activeGenerationTable } from "../database/schema";
import { acceptGeneration, readVariantDetails } from "../conversation";
import { recoverActiveGenerations } from "./generation-recovery";

const prompt = shortReplyPrompt();

describe("generation recovery diagnostics", () => {
	let database: Database;

	beforeEach(() => {
		database = openObservedDatabase();
	});

	afterEach(() => database.close());

	test("continues recovering healthy rows and reports a corrupt row with its identity", () => {
		const conversation = database;
		const created = createConversationWithHistory(conversation, {
			name: "Recovery Diagnostics Chat",
			participants: [
				participantSeed("Writer", { prompt }),
				participantSeed("Maren", { prompt, openings: ["Original answer."] }),
			],
			control: { human: 0, model: 1 },
		});
		const human = created.cast[0];
		const model = created.cast[1];
		const target = created.messages[0];
		if (human === undefined || model === undefined || target === undefined) {
			throw new Error("Recovery fixture is incomplete.");
		}
		const accepted = (timestamp: string) => acceptGeneration(database, {
			seed: "test-generation-seed",
			conversationId: created.id,
			timestamp,
			humanParticipantId: human.id,
			modelParticipantId: model.id,
			capturedHumanName: human.name,
			capturedModelName: model.name,
			promptPlan: { blocks: [], warnings: [], images: [] },
			modelId: "fixture-model",
			promptInspection: { tokenEstimate: 0, responseBudget: 64, safetyAllowance: 0, contextLimit: 128, totalRequiredTokens: 64, omittedContext: [] },
		}, { kind: "sibling", messageId: target.id });
		const corrupt = accepted("2026-08-27T00:00:00.000Z");
		accepted("2026-08-27T00:00:01.000Z");
		const checkpointed = accepted("2026-08-27T00:00:02.000Z");
		checkpointFromStart(database, {
			conversationId: created.id,
			generationId: checkpointed.generationId,
			content: "Recovered checkpoint.",
			reasoning: "Recovered reasoning.",
			latestEventId: 2,
		});
		const db = drizzle(database);
		const intent = db.select({ json: activeGenerationTable.generation_intent_json })
			.from(activeGenerationTable).where(eq(activeGenerationTable.id, corrupt.generationId)).get();
		if (intent === undefined) throw new Error("Recovery fixture is missing the original intent.");
		db.update(activeGenerationTable)
			.set({ generation_intent_json: "{}" })
			.where(eq(activeGenerationTable.id, corrupt.generationId))
			.run();

		const errors: string[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
		let summary;
		try {
			summary = recoverActiveGenerations(database);
		} finally {
			console.error = originalError;
		}

		expect(summary).toEqual({ inspected: 3, interrupted: 1, removed: 1, failed: 1 });
		expect(drizzle(database)
			.select({ id: activeGenerationTable.id })
			.from(activeGenerationTable)
			.all()).toEqual([{ id: corrupt.generationId }]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("server-restart");
		expect(errors[0]).toContain(`generation ${corrupt.generationId}`);
		expect(errors[0]).toContain(`conversation ${created.id}`);
		expect(errors[0]).toContain("invalid persisted Generation intent");
		const details = readVariantDetails(database, created.id, target.id, checkpointed.provisionalVariantId);
		expect(details).toMatchObject({
			content: "Recovered checkpoint.",
			provenance: { status: "interrupted", interruptionCause: "server-restart" },
		});
		expect(JSON.stringify(details)).not.toContain("Recovered reasoning.");

		db.update(activeGenerationTable).set({ generation_intent_json: intent.json })
			.where(eq(activeGenerationTable.id, corrupt.generationId)).run();
		expect(recoverActiveGenerations(database)).toEqual({ inspected: 1, interrupted: 0, removed: 1, failed: 0 });
		expect(recoverActiveGenerations(database)).toEqual({ inspected: 0, interrupted: 0, removed: 0, failed: 0 });
	});
});
