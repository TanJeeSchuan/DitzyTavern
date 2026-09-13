import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInitializedDatabase } from "../database/database";
import { createConversationRoutes } from "./conversation";
import {
	captureModelFetch,
	completeGeneration,
	createChat,
	duplicateBlock,
	key,
	moveBlock,
	readInspection,
	readOperation,
	readPreset,
	slotOf,
	startGeneration,
	toggleBlock,
	withProfile,
} from "./prompt-preset-test-fixtures";

describe("Prompt Preset budget", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("estimates and inspection account for the actual assembled output, including deliberate repeats", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch(() => {}),
		});

		const generationId = await startGeneration(app, conversation.id, conversation.revision);
		const inspection = await readInspection(app, conversation.id, generationId);
		const singleEstimate = inspection.budget.tokenEstimate;
		expect(
			inspection.promptPlan.blocks.filter((block) => block.kind === "example-dialogue"),
		).toHaveLength(1);
		await completeGeneration(app, conversation.id, generationId);

		const preset = await readPreset(app, conversation.id);
		const example = slotOf(preset, "model-example-dialogue");
		if (example === undefined) throw new Error("The Default recipe has no Example Dialogue slot.");
		await readOperation(duplicateBlock(database, preset.id, example.id));

		const repeatedRevisionResponse = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}`),
		);
		// SAFETY: the route's response schema is the Conversation summary.
		const repeatedRevision = await repeatedRevisionResponse.json() as { revision: number };
		const repeatedGenerationId = await startGeneration(
			app,
			conversation.id,
			repeatedRevision.revision,
		);
		const repeatedInspection = await readInspection(app, conversation.id, repeatedGenerationId);
		expect(
			repeatedInspection.promptPlan.blocks.filter((block) => block.kind === "example-dialogue"),
		).toHaveLength(2);
		// The estimate counts the repeated content: the assembled output grew
		// and the budget decision follows the actual request.
		expect(repeatedInspection.budget.tokenEstimate).toBeGreaterThan(singleEstimate);
		await completeGeneration(app, conversation.id, repeatedGenerationId);
	});
});

describe("Prompt Preset durability", () => {
	let directory: string;

	beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "ditzy-preset-")); });
	afterEach(async () => {
		// ==[HUMAN APPROVED]== Bun may release the final SQLite WAL handle asynchronously on Windows.
		for (let attempt = 0; attempt < 20; attempt += 1) {
			try {
				rmSync(directory, { recursive: true, force: true });
				return;
			} catch {
				await Bun.sleep(100);
			}
		}
		rmSync(directory, { recursive: true, force: true });
	});

	test("keeps the saved recipe edits and Chat selection across restarts", async () => {
		const path = join(directory, "preset.sqlite");
		const first = openInitializedDatabase({ path });
		const conversation = createChat(first);
		const app = createConversationRoutes(first);
		const preset = await readPreset(app, conversation.id);
		const example = slotOf(preset, "model-example-dialogue");
		const identity = slotOf(preset, "model-identity");
		if (example === undefined || identity === undefined) {
			throw new Error("The Default recipe is missing its reference slots.");
		}
		await readOperation(toggleBlock(first, preset.id, example.id, false));
		await readOperation(moveBlock(first, preset.id, identity.id, 1));
		first.close();

		const second = openInitializedDatabase({ path });
		try {
			const reread = await readPreset(createConversationRoutes(second), conversation.id);
			expect(reread.name).toBe("Default");
			expect(reread.slots.map((slot) => [slot.reference, slot.enabled])).toEqual([
				["model-identity", true],
				["model-system-instruction", true],
				["human-identity", true],
				["model-scenario", true],
				["model-example-dialogue", false],
				["history", true],
				["model-post-history-instruction", true],
			]);
			expect(second.query("SELECT COUNT(*) AS total FROM prompt_preset").get())
				.toEqual({ total: 1 });
		} finally {
			second.close();
		}
	});
});
