import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConversationRoutes } from "./conversation";
import {
	captureModelFetch,
	completeGeneration,
	createChat,
	duplicateBlock,
	key,
	readInspection,
	readOperation,
	readPreset,
	slotOf,
	startGeneration,
	withProfile,
} from "./prompt-preset-test-fixtures";

import { observeConversationWrites } from "../conversation";
import { syncMemorySources } from "../memory";
describe("Prompt Preset budget", () => {
	let database: Database;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		observeConversationWrites(database, syncMemorySources);
	});
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
