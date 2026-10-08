import { openObservedDatabase } from "../conversation/test-fixtures";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createConnectionSettingsModule } from "../connection-settings";
import { createConversationRoutes } from "./conversation";
import {
	CapturedRequest,
	completeGeneration,
	captureModelFetch,
	createChat,
	createRoutes,
	gatedProvider,
	key,
	moveBlock,
	profile,
	readActiveInspection,
	readConversation,
	readOperation,
	readPreset,
	readSelectedPreset,
	runPresetCommand,
	selectPreset,
	saveBlockRole,
	slotOf,
	startGeneration,
	withProfile,
} from "./prompt-preset-test-fixtures";

// ==[HUMAN APPROVED]== Generation capture coverage: an Active Generation keeps the Prompt Plan
// it captured, whatever the shared recipe or the Conversation selection does
// while the attempt streams, and later attempts compile the latest saved
// state.
describe("Prompt Preset capture", () => {
	let database: Database;

	beforeEach(() => {
		database = openObservedDatabase();
	});
	afterEach(() => database.close());

	test("an Active Generation keeps its captured plan while saved edits take effect on the next Generation", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const app = createConversationRoutes(database);
		const preset = await readPreset(app, conversation.id);
		const postHistory = slotOf(preset, "model-post-history-instruction");
		const scenario = slotOf(preset, "model-scenario");
		if (postHistory === undefined || scenario === undefined) {
			throw new Error("The Default recipe is missing its reference slots.");
		}

		let captured: CapturedRequest | undefined;
		let release = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const gated = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch((request) => { captured = request; }, gate),
		});
		const generationId = await startGeneration(gated, conversation.id, conversation.revision);
		while (captured === undefined) await new Promise((resolve) => setTimeout(resolve, 0));

		// While the attempt streams, the shared recipe is edited.
		await readOperation(moveBlock(database, preset.id, postHistory.id, 1));
		await readOperation(saveBlockRole(database, preset.id, scenario.id, "user"));

		// The Active Generation consumes the Prompt Plan captured when it was
		// prepared; the saved edit cannot rewrite the request in flight.
		expect(captured?.messages).toEqual([
			{ role: "system", content: "Answer briefly." },
			{ role: "user", content: "I write as Writer opposite Maren." },
			{ role: "assistant", content: "I am Maren." },
			{ role: "system", content: "A quiet room." },
			{ role: "user", content: "Writer: Hello\nMaren: Hello back" },
			{ role: "user", content: "Writer: Set the scene." },
			{ role: "system", content: "Continue." },
		]);

		release();
		await completeGeneration(gated, conversation.id, generationId);
		// The next Generation compiles the latest saved recipe without
		// reconstructing the Conversation.
		let capturedNext: CapturedRequest | undefined;
		const subsequent = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch((request) => { capturedNext = request; }),
		});
		const summaryResponse = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}`),
		);
		// SAFETY: the route's response schema is the Conversation summary.
		const summary = await summaryResponse.json() as { revision: number };
		const nextId = await startGeneration(subsequent, conversation.id, summary.revision);
		await completeGeneration(subsequent, conversation.id, nextId);
		while (capturedNext === undefined) await new Promise((resolve) => setTimeout(resolve, 0));

		expect(capturedNext?.messages).toEqual([
			{ role: "system", content: "Continue." },
			{ role: "system", content: "Answer briefly." },
			{ role: "user", content: "I write as Writer opposite Maren." },
			{ role: "assistant", content: "I am Maren." },
			{ role: "user", content: "A quiet room." },
			{ role: "user", content: "Writer: Hello\nMaren: Hello back" },
			{ role: "user", content: "Writer: Set the scene." },
			{ role: "assistant", content: "Maren: Done." },
			{ role: "user", content: "Writer: Set the scene." },
		]);
	});
});

describe("Prompt Preset selection around an Active Generation", () => {
	let database: Database;

	beforeEach(() => {
		database = openObservedDatabase();
	});
	afterEach(() => database.close());

	test("a selection change during an attempt keeps its captured Prompt Plan and later attempts use the new selection", async () => {
		const routes = createRoutes(database);
		const conversation = createChat(database);
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "preset-secret",
		});
		// The editor tickets add block operations; until then this test stands
		// in for one saved recipe difference the same way the established
		// prompt-preset transport tests do: the duplicate loses its Example
		// Dialogue slot, so the two selections assemble distinguishable
		// requests.
		await runPresetCommand(routes.library, {
			type: "duplicate",
			presetId: 1,
			expectedRevision: 0,
			name: "Copy of Default",
		});
		database.exec(
			"UPDATE prompt_preset_block SET enabled = 0 WHERE preset_id = 2 AND reference = 'model-example-dialogue'",
		);
		const gate = gatedProvider();
		const app = createConversationRoutes(database, { masterKey: key, fetch: gate.fetch });

		const firstGenerationId = await startGeneration(
			app,
			conversation.id,
			conversation.revision,
			gate,
		);
		// The first attempt assembles through the Default recipe.
		expect(gate.requests[0]?.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"system",
			"user",
			"user",
			"system",
		]);
		const firstSubscription = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${firstGenerationId}/events`,
		));
		const firstBody = firstSubscription.text();

		// While that attempt runs, the Chat switches to the copy: the switch
		// commits durably even with an Active Generation present.
		const summary = await readConversation(app, conversation.id);
		const switched = await selectPreset(app, conversation.id, summary.revision, 2);
		expect(switched.status).toBe(200);
		const switchedRead = await readSelectedPreset(app, conversation.id);
		expect(switchedRead?.id).toBe(2);

		// The completed request describes the Default assembly it captured, not
		// the mid-flight switch, and the active inspection agrees.
		expect((await readActiveInspection(app, conversation.id, firstGenerationId)).map(
			(block) => block.kind,
		)).toEqual([
			"system-instruction",
			"identity",
			"identity",
			"scenario",
			"example-dialogue",
			"history",
			"post-history-instruction",
		]);
		gate.release();
		await firstBody;
		expect(gate.requests[0]?.messages.map((message) => message.content)).toEqual([
			"Answer briefly.",
			"I write as Writer opposite Maren.",
			"I am Maren.",
			"A quiet room.",
			"Writer: Hello\nMaren: Hello back",
			"Writer: Set the scene.",
			"Continue.",
		]);

		// Later attempts use the new valid selection: the copy's stored recipe
		// is missing the Example Dialogue block the test disabled.
		const afterGeneration = await readConversation(app, conversation.id);
		const secondGenerationId = await startGeneration(
			app,
			conversation.id,
			afterGeneration.revision,
			gate,
			2,
		);
		gate.release();
		await completeGeneration(app, conversation.id, secondGenerationId);
		expect(gate.requests[1]?.messages).toEqual([
			{ role: "system", content: "Answer briefly." },
			{ role: "user", content: "I write as Writer opposite Maren." },
			{ role: "assistant", content: "I am Maren." },
			{ role: "system", content: "A quiet room." },
			// The attempt's own captured history: the first human Message and the
			// model output the first attempt resolved, then the new tail.
			{ role: "user", content: "Writer: Set the scene." },
			{ role: "assistant", content: "Maren: Done." },
			{ role: "user", content: "Writer: Set the scene." },
			{ role: "system", content: "Continue." },
		]);
	});

	test("deleting the selected preset during an attempt reassigns atomically and keeps the captured plan", async () => {
		const routes = createRoutes(database);
		const conversation = createChat(database);
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "preset-secret",
		});
		// Stand-in recipe difference, exactly like the established transport
		// tests: the copy loses its Example Dialogue slot, so the captured
		// request and the reassigned Default request are distinguishable.
		await runPresetCommand(routes.library, {
			type: "duplicate",
			presetId: 1,
			expectedRevision: 0,
			name: "Copy of Default",
		});
		database.exec(
			"UPDATE prompt_preset_block SET enabled = 0 WHERE preset_id = 2 AND reference = 'model-example-dialogue'",
		);
		await selectPreset(routes.conversations, conversation.id, conversation.revision, 2);

		const gate = gatedProvider();
		const app = createConversationRoutes(database, { masterKey: key, fetch: gate.fetch });

		const generationId = await startGeneration(
			app,
			conversation.id,
			(await readConversation(app, conversation.id)).revision,
			gate,
		);
		const subscription = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/${generationId}/events`,
		));
		const attemptBody = subscription.text();

		// The Active attempt holds the copy's captured plan.
		expect((await readActiveInspection(app, conversation.id, generationId)).map(
			(block) => block.kind,
		)).toEqual([
			"system-instruction",
			"identity",
			"identity",
			"scenario",
			"history",
			"post-history-instruction",
		]);

		// The confirmed deletion reassigns this Chat to Default in the same
		// authoritative operation, while the attempt keeps running.
		const deleted = await runPresetCommand(routes.library, {
			type: "delete",
			presetId: 2,
			expectedRevision: 0,
			expectedConversationCount: 1,
		});
		expect(deleted.status).toBe(200);
		expect(deleted.body).toEqual({
			outcome: "deleted",
			result: { presetId: 2, reassignedConversationCount: 1 },
		});
		const reassigned = await readSelectedPreset(app, conversation.id);
		expect(reassigned?.id).toBe(1);
		expect(reassigned?.name).toBe("Default");
		// The Active attempt still reports the plan it captured, untouched.
		expect((await readActiveInspection(app, conversation.id, generationId)).map(
			(block) => block.kind,
		)).toEqual([
			"system-instruction",
			"identity",
			"identity",
			"scenario",
			"history",
			"post-history-instruction",
		]);
		gate.release();
		await attemptBody;
		expect(gate.requests[0]?.messages.map((message) => message.content)).toEqual([
			"Answer briefly.",
			"I write as Writer opposite Maren.",
			"I am Maren.",
			"A quiet room.",
			"Writer: Set the scene.",
			"Continue.",
		]);

		// The next attempt assembles through Default again.
		const afterGeneration = await readConversation(app, conversation.id);
		const nextGenerationId = await startGeneration(
			app,
			conversation.id,
			afterGeneration.revision,
			gate,
			2,
		);
		gate.release();
		await completeGeneration(app, conversation.id, nextGenerationId);
		expect(gate.requests[1]?.messages.map((message) => message.content)).toEqual([
			"Answer briefly.",
			"I write as Writer opposite Maren.",
			"I am Maren.",
			"A quiet room.",
			// Default again: the Example Dialogue returns, and the resolved first
			// attempt joins the selected history ahead of the new tail.
			"Writer: Hello\nMaren: Hello back",
			"Writer: Set the scene.",
			"Maren: Done.",
			"Writer: Set the scene.",
			"Continue.",
		]);
	});

	test("an attempt through a blank preset captures the actual empty recipe", async () => {
		const routes = createRoutes(database);
		const conversation = createChat(database);
		createConnectionSettingsModule(database, { masterKey: key }).createProfile({
			expectedRevision: 0,
			profile,
			credential: "preset-secret",
		});
		await runPresetCommand(routes.library, { type: "create", name: "Blank" });
		await selectPreset(routes.conversations, conversation.id, conversation.revision, 2);

		// A recipe without slots reaches the structural request rules with an
		// empty plan: acceptance commits, the captured plan stays empty, and no
		// provider request is assembled. The gate must not wait for a captured
		// request that never happens.
		const gate = gatedProvider();
		const app = createConversationRoutes(database, { masterKey: key, fetch: gate.fetch });
		const generationId = await startGeneration(
			app,
			conversation.id,
			(await readConversation(app, conversation.id)).revision,
			gate,
			0,
		);

		expect(await readActiveInspection(app, conversation.id, generationId)).toEqual([]);

		gate.release();
		await completeGeneration(app, conversation.id, generationId);
		// The zero-block attempt produced no usable output, so the existing
		// zero-output policy removes it; the Chat keeps its valid Default
		// selection for later attempts.
		const settled = await readSelectedPreset(app, conversation.id);
		expect(settled?.id).toBe(2);
		expect(gate.requests).toHaveLength(0);
	});
});