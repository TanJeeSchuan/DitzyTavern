import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { initializeDatabase, openDatabase } from "../database/database";
import { activeGenerationTable } from "../database/schema";
import {
	acceptConversationSiblingGeneration,
	createConversationModule,
} from "../conversation";
import { recoverActiveGenerations } from "./generation-recovery";

const prompt = {
	systemInstruction: "Answer briefly.",
	identity: "I am {{self}}.",
	scenario: "The room is quiet.",
	exampleDialogue: "",
	postHistoryInstruction: "Continue.",
};

describe("generation recovery diagnostics", () => {
	let database: Database;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
		initializeDatabase(database);
	});

	afterEach(() => database.close());

	test("continues recovering healthy rows and reports a corrupt row with its identity", () => {
		const conversation = createConversationModule(database);
		const created = conversation.create({
			name: "Recovery Diagnostics Chat",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: ["Original answer."] } },
			],
			control: { human: 0, model: 1 },
		});
		const human = created.cast[0];
		const model = created.cast[1];
		const target = created.messages[0];
		if (human === undefined || model === undefined || target === undefined) {
			throw new Error("Recovery fixture is incomplete.");
		}
		const accepted = (timestamp: string) => acceptConversationSiblingGeneration(database, {
			conversationId: created.id,
			messageId: target.id,
			timestamp,
			humanParticipantId: human.id,
			modelParticipantId: model.id,
			capturedModelName: model.name,
			promptPlan: { blocks: [], warnings: [], images: [] },
			promptContext: [],
			generationSettings: {},
			connection: {},
		});
		const corrupt = accepted("2026-08-27T00:00:00.000Z");
		accepted("2026-08-27T00:00:01.000Z");
		drizzle(database)
			.update(activeGenerationTable)
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

		expect(summary).toEqual({ inspected: 2, interrupted: 0, removed: 1, failed: 1 });
		expect(drizzle(database)
			.select({ id: activeGenerationTable.id })
			.from(activeGenerationTable)
			.all()).toEqual([{ id: corrupt.generationId }]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("server-restart");
		expect(errors[0]).toContain(`generation ${corrupt.generationId}`);
		expect(errors[0]).toContain(`conversation ${created.id}`);
		expect(errors[0]).toContain("invalid persisted Generation intent");
	});
});
