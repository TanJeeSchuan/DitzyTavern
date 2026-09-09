import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import {
	CapturedRequest,
	completeGeneration,
	conversationApp,
	captureModelFetch,
	createChat,
	duplicateBlock,
	key,
	libraryRoutes,
	moveBlock,
	recipeRoutes,
	readOperation,
	readPreset,
	removeBlock,
	saveInstructionContent,
	slotOf,
	startGeneration,
	toggleBlock,
	withProfile,
} from "./prompt-preset-test-fixtures";

// ==[HUMAN APPROVED]== Authored instruction coverage through the public routes and captured
// Generation requests: recipe operations on authored instruction blocks,
// and the shared-and-copied recipe lifecycle. The authored instruction
// macro language and its warnings live in the instruction macros suite.
describe("Prompt Preset authored instructions", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	const addInstruction = (presetId: number) =>
		recipeRoutes(database).handle(
			new Request(`http://localhost/api/prompt-presets/${presetId}/instructions`, {
				method: "POST",
			}),
		);

	test("add, save, move, toggle, duplicate and remove work for authored instruction blocks", async () => {
		const conversation = createChat(database);
		const preset = await readPreset(conversationApp(database), conversation.id);

		const added = await readOperation(addInstruction(preset.id));
		const instruction = added.slots.at(-1);
		expect(instruction).toEqual({
			id: expect.any(Number),
			reference: "instruction",
			enabled: true,
			role: "system",
			name: "Instruction",
			content: "",
		});

		// The one block-level save persists name, text, and role together.
		const saved = await readOperation(saveInstructionContent(
			database,
			preset.id,
			// SAFETY: the occurrence above exists in the response recipe.
			(instruction as { id: number }).id,
			{ name: "Tone", content: "Write like {{self}}.", role: "assistant" },
		));
		const savedSlot = slotOf(saved, "instruction");
		if (savedSlot === undefined) throw new Error("The saved instruction is missing.");
		expect(savedSlot).toEqual({
			id: expect.any(Number),
			reference: "instruction",
			enabled: true,
			role: "assistant",
			name: "Tone",
			content: "Write like {{self}}.",
		});

		// Instruction blocks participate in the same ordered recipe operations.
		// Move it to the front, then duplicate it while both copies are enabled.
		const moved = await readOperation(moveBlock(database, preset.id, savedSlot.id, 1));
		expect(moved.slots[0]?.reference).toBe("instruction");
		const duplicated = await readOperation(
			duplicateBlock(database, preset.id, savedSlot.id),
		);
		expect(duplicated.slots.filter((slot) => slot.reference === "instruction")).toHaveLength(2);

		// disabling one occurrence leaves the other enabled and in place.
		const toggled = await readOperation(
			toggleBlock(database, preset.id, savedSlot.id, false),
		);
		expect(slotOf(toggled, "instruction")?.enabled).toBe(false);

		// A deliberate duplicate is independently editable: saving the second
		// copy's text and role leaves the disabled original untouched.
		const copy = toggled.slots.filter((slot) => slot.reference === "instruction")[1];
		if (copy === undefined) throw new Error("The duplicated instruction is missing.");
		// SAFETY: the copy exists in the response recipe.
		const copySaved = await readOperation(saveInstructionContent(
			database,
			preset.id,
			copy.id,
			{ name: "Copy", content: "Independent text.", role: "user" },
		));
		const copies = copySaved.slots.filter((slot) => slot.reference === "instruction");
		expect(copies[0]).toEqual({
			id: expect.any(Number),
			reference: "instruction",
			enabled: false,
			role: "assistant",
			name: "Tone",
			content: "Write like {{self}}.",
		});
		expect(copies[1]).toEqual({
			id: expect.any(Number),
			reference: "instruction",
			enabled: true,
			role: "user",
			name: "Copy",
			content: "Independent text.",
		});

		// Removing one occurrence leaves the other exactly where it was.
		const removed = await readOperation(removeBlock(database, preset.id, copies[0].id));
		expect(removed.slots.filter((slot) => slot.reference === "instruction")).toEqual([
			copies[1],
		]);
	});

	test("refuses a text save on a referenced occurrence", async () => {
		const conversation = createChat(database);
		const preset = await readPreset(conversationApp(database), conversation.id);
		const identity = slotOf(preset, "human-identity");
		if (identity === undefined) throw new Error("The Default recipe has no Identity slot.");

		const response = await saveInstructionContent(database, preset.id, identity.id, {
			name: "Nope",
			content: "Nope",
			role: "system",
		});
		expect(response.status).toBe(422);
		// SAFETY: the route's typed invalid outcome.
		const outcome = await response.json() as { outcome: string; reason: string };
		expect(outcome.outcome).toBe("invalid");
		expect(outcome.reason).toContain("instruction");
	});
});
describe("Prompt Preset authored instructions, shared and copied", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	const presetRevision = async (presetId: number): Promise<number> => {
		const response = await libraryRoutes(database).handle(new Request("http://localhost/api/prompt-presets"));
		expect(response.status).toBe(200);
		// SAFETY: the route's response schema is the typed preset list.
		const payload = await response.json() as { presets: { id: number; revision: number }[] };
		const summary = payload.presets.find((preset) => preset.id === presetId);
		if (summary === undefined) throw new Error("The preset is not listed.");
		return summary.revision;
	};

	const addInstruction = (presetId: number) =>
		recipeRoutes(database).handle(
			new Request(`http://localhost/api/prompt-presets/${presetId}/instructions`, {
				method: "POST",
			}),
		);

	const duplicatePreset = async (presetId: number, name: string) => {
		const expectedRevision = await presetRevision(presetId);
		const response = await libraryRoutes(database).handle(
			new Request("http://localhost/api/prompt-presets/commands", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ type: "duplicate", presetId, expectedRevision, name }),
			}),
		);
		expect(response.status).toBe(200);
		// SAFETY: this test controls the typed applied response.
		return await response.json() as {
			outcome: "applied";
			preset: { id: number; name: string; revision: number };
		};
	};

	const selectPresetFor = async (
		conversationId: number,
		expectedRevision: number,
		promptPresetId: number,
	) => {
		const response = await conversationApp(database).handle(
			new Request(`http://localhost/api/conversations/${conversationId}/commands`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedRevision,
					action: { type: "select-prompt-preset", promptPresetId },
				}),
			}),
		);
		expect(response.status).toBe(200);
		// SAFETY: the route's response schema is the conversation applied summary.
		return await response.json() as { conversation: { revision: number } };
	};

	const captureMessages = async (conversationId: number, revision: number) => {
		let captured: CapturedRequest | undefined;
		const generating = conversationApp(database, {
			masterKey: key,
			fetch: captureModelFetch((request) => { captured = request; }),
		});
		const generationId = await startGeneration(generating, conversationId, revision);
		await completeGeneration(generating, conversationId, generationId);
		while (captured === undefined) await new Promise((resolve) => setTimeout(resolve, 0));
		return captured;
	};

	test("shared authored text reaches every selecting Chat while a duplicated preset stays independent", async () => {
		const first = createChat(database);
		const second = createChat(database);
		const third = createChat(database);
		withProfile(database);
		const preset = await readPreset(conversationApp(database), first.id);

		// The third Chat uses an independent copy of the shared preset.
		const duplicated = await duplicatePreset(preset.id, "Copy");
		const thirdRevision = await selectPresetFor(
			third.id,
			third.revision,
			duplicated.preset.id,
		);

		// A saved instruction on the shared preset reaches both selecting
		// Chats and never reaches the copy.
		const added = await readOperation(addInstruction(preset.id));
		const instruction = added.slots.at(-1);
		if (instruction === undefined) throw new Error("The instruction was not added.");
		await readOperation(saveInstructionContent(
			database,
			preset.id,
			instruction.id,
			{ name: "Tone", content: "Write like {{self}}.", role: "assistant" },
		));

		const firstRequest = await captureMessages(first.id, first.revision);
		const secondRequest = await captureMessages(second.id, second.revision);
		const thirdRequest = await captureMessages(third.id, thirdRevision.conversation.revision);

		// The two shared-preset Chats assemble the saved instruction with their
		// own Participant names; the copy's recipe has no instruction at all.
		expect(firstRequest?.messages).toContainEqual({
			role: "assistant",
			content: "Write like Writer.",
		});
		expect(secondRequest?.messages).toContainEqual({
			role: "assistant",
			content: "Write like Writer.",
		});
		expect(
			thirdRequest?.messages.some((message) => message.content.startsWith("Write like")),
		).toBe(false);
	});

	test("the copy's own saved instruction never reaches the shared preset or its Chats", async () => {
		const shared = createChat(database);
		const copy = createChat(database);
		withProfile(database);
		const preset = await readPreset(conversationApp(database), shared.id);

		const duplicated = await duplicatePreset(preset.id, "Copy");
		const copyRevision = await selectPresetFor(copy.id, copy.revision, duplicated.preset.id);

		// Editing the copy's recipe later is invisible to the shared preset.
		const added = await readOperation(addInstruction(duplicated.preset.id));
		const instruction = added.slots.at(-1);
		if (instruction === undefined) throw new Error("The instruction was not added.");
		await readOperation(saveInstructionContent(
			database,
			duplicated.preset.id,
			instruction.id,
			{ name: "CopyOnly", content: "Only the copy has this.", role: "system" },
		));

		const copyRequest = await captureMessages(copy.id, copyRevision.conversation.revision);
		const sharedRequest = await captureMessages(shared.id, shared.revision);
		expect(copyRequest?.messages).toContainEqual({
			role: "system",
			content: "Only the copy has this.",
		});
		expect(
			sharedRequest?.messages.some((message) => message.content === "Only the copy has this."),
		).toBe(false);
	});
});