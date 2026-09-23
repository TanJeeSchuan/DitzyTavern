import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConversationRoutes } from "./conversation";
import {
	addPromptPresetInstruction,
	executePromptPresetCommand,
	movePromptPresetBlock,
	InvalidPromptPresetOperationError,
	readPromptPresetRecipe,
} from "../prompt-preset";
import {
	CapturedRequest,
	addBlock,
	captureModelFetch,
	completeGeneration,
	createChat,
	duplicateBlock,
	key,
	modelPrompt,
	moveBlock,
	readInspection,
	readOperation,
	readPreset,
	readStoredRecipe,
	removeBlock,
	saveBlockPatches,
	saveBlockRole,
	slotOf,
	startGeneration,
	toggleBlock,
	withProfile,
} from "./prompt-preset-test-fixtures";

// ==[HUMAN APPROVED]== The owning module guards a move target the transport schema cannot
// deliver, so a direct caller cannot displace an occurrence either.
describe("Prompt Preset move bounds", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("rejects a move to position 0 with the typed invalid outcome", () => {
		createChat(database);
		expect(() => movePromptPresetBlock(database, 1, 1, 0)).toThrow(
			InvalidPromptPresetOperationError,
		);
	});
});

describe("Prompt Preset stored contract boundary", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("keeps empty authored text and rejects invalid instruction rows", () => {
		const recipe = addPromptPresetInstruction(database, 1);
		const instruction = recipe.slots.find((slot) => slot.reference === "instruction");
		if (instruction === undefined) throw new Error("The instruction fixture is missing.");

		database.exec(`UPDATE prompt_preset_block SET name = '', content = '' WHERE id = ${instruction.id}`);
		const empty = readPromptPresetRecipe(database, 1);
		const emptyInstruction = empty?.slots.find((slot) => slot.reference === "instruction");
		expect(emptyInstruction).toMatchObject({ name: "", content: "", role: "system" });

		expect(() => database.exec(
			`UPDATE prompt_preset_block SET name = NULL WHERE id = ${instruction.id}`,
		)).toThrow("CHECK constraint failed");
		expect(() => database.exec(
			`UPDATE prompt_preset_block SET content = NULL WHERE id = ${instruction.id}`,
		)).toThrow("CHECK constraint failed");
		expect(() => database.exec(
			`UPDATE prompt_preset_block SET role = NULL WHERE id = ${instruction.id}`,
		)).toThrow("CHECK constraint failed");
	});

	test("enforces one Lore block at the persistence boundary, including disabled blocks", () => {
		const lore = readPromptPresetRecipe(database, 1)?.slots.find((slot) => slot.reference === "lore");
		if (lore === undefined) throw new Error("The Default recipe is missing its Lore block.");

		database.exec(`UPDATE prompt_preset_block SET enabled = 0 WHERE id = ${lore.id}`);
		expect(() => database.exec(
			"INSERT INTO prompt_preset_block (preset_id, position, reference, enabled, role) VALUES (1, 99, 'lore', 1, 'system')",
		)).toThrow("UNIQUE constraint failed");
	});

	test("enforces one Memory block at the persistence boundary, including disabled blocks", () => {
		const memory = readPromptPresetRecipe(database, 1)?.slots.find((slot) => slot.reference === "memory");
		if (memory === undefined) throw new Error("The Default recipe is missing its Memory block.");
		database.exec(`UPDATE prompt_preset_block SET enabled = 0 WHERE id = ${memory.id}`);
		expect(() => database.exec(
			"INSERT INTO prompt_preset_block (preset_id, position, reference, enabled, role) VALUES (1, 99, 'memory', 1, 'system')",
		)).toThrow("UNIQUE constraint failed");
	});
});

describe("Prompt Preset transport", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("resolves the Default recipe against this Chat's own Participants", async () => {
		const conversation = createChat(database);
		const app = createConversationRoutes(database);

		const preset = await readPreset(app, conversation.id);

		expect(preset.name).toBe("Default");
		expect(preset.slots.map((slot) => slot.reference)).toEqual([
			"model-system-instruction",
			"human-identity",
			"model-identity",
			"model-scenario",
			"model-example-dialogue",
			"lore",
			"memory",
			"history",
			"model-post-history-instruction",
		]);
		expect(preset.slots.every((slot) => slot.enabled)).toBe(true);
		// Every occurrence carries its own identity for targeted operations.
		expect(new Set(preset.slots.map((slot) => slot.id)).size).toBe(preset.slots.length);
		// The recipe stores references, so each slot reads the Conversation-local
		// Definition of the Participant in that Control seat — including the
		// authored macro text, which the preset never stores rendered — and the
		// outgoing role the established assembly presents it with.
		const slots = (reference: string) =>
			preset.slots.filter((slot) => slot.reference === reference);
		expect(slots("human-identity")).toEqual([{
			id: expect.any(Number),
			reference: "human-identity",
			enabled: true,
			role: "user",
			sourceName: "Writer",
			content: "I write as {{self}} opposite {{other}}.",
		}]);
		expect(slots("model-identity")).toEqual([{
			id: expect.any(Number),
			reference: "model-identity",
			enabled: true,
			role: "assistant",
			sourceName: "Maren",
			content: "I am {{self}}.",
		}]);
		expect(slots("model-system-instruction")).toEqual([{
			id: expect.any(Number),
			reference: "model-system-instruction",
			enabled: true,
			role: "system",
			sourceName: "Maren",
			content: "Answer briefly.",
		}]);
		expect(slots("lore")).toEqual([{
			id: expect.any(Number),
			reference: "lore",
			enabled: true,
			role: "system",
		}]);
		expect(slots("history")).toEqual([{
			id: expect.any(Number),
			reference: "history",
			enabled: true,
			entryCount: 0,
		}]);
	});

	test("returns not-found for a Conversation that does not exist", async () => {
		const app = createConversationRoutes(database);
		const response = await app.handle(
			new Request("http://localhost/api/conversations/424242/prompt-preset"),
		);
		expect(response.status).toBe(404);
	});

	test("assembles the outgoing request through the stored recipe and agrees with active inspection", async () => {
		const conversation = createChat(database);
		withProfile(database);
		let captured: CapturedRequest | undefined;
		let release = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const app = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch((request) => { captured = request; }, gate),
		});

		const generationId = await startGeneration(app, conversation.id, conversation.revision);
		while (captured === undefined) await new Promise((resolve) => setTimeout(resolve, 0));

		const inspection = await readInspection(app, conversation.id, generationId);

		// The Default recipe reproduces the established request: system text,
		// both Identity blocks under their roles, Scenario, Example Dialogue,
		// the selected history, then the Post-History Instruction.
		expect(captured?.messages).toEqual([
			{ role: "system", content: "Answer briefly." },
			{ role: "user", content: "I write as Writer opposite Maren." },
			{ role: "assistant", content: "I am Maren." },
			{ role: "system", content: "A quiet room." },
			{ role: "user", content: "Writer: Hello\nMaren: Hello back" },
			{ role: "user", content: "Writer: Set the scene." },
			{ role: "system", content: "Continue." },
		]);
		expect(inspection.promptPlan.blocks.map((block) => block.kind)).toEqual([
			"system-instruction",
			"identity",
			"identity",
			"scenario",
			"example-dialogue",
			"history",
			"post-history-instruction",
		]);

		release();
		await completeGeneration(app, conversation.id, generationId);
	});

	test("saved rearrangement, toggles, duplicates, additions and removals drive the assembled request and survive a fresh read", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const app = createConversationRoutes(database);
		const preset = await readPreset(app, conversation.id);
		const scenario = slotOf(preset, "model-scenario");
		const history = slotOf(preset, "history");
		const postHistory = slotOf(preset, "model-post-history-instruction");
		if (scenario === undefined || history === undefined || postHistory === undefined) {
			throw new Error("The Default recipe is missing its reference slots.");
		}

		// Disable the Scenario occurrence: it must vanish from the request
		// without being reinserted anywhere.
		await readOperation(
			toggleBlock(database, preset.id, scenario.id, false),
		);
		const toggled = readStoredRecipe(database, preset.id);
		expect(slotOf(toggled, "model-scenario")?.enabled).toBe(false);

		// Move the Post-History Instruction ahead of everything else.
		await readOperation(
			moveBlock(database, preset.id, postHistory.id, 1),
		);
		const moved = readStoredRecipe(database, preset.id);
		expect(moved.slots[0]?.reference).toBe("model-post-history-instruction");

		// Deliberately repeat the history slot right after itself.
		await readOperation(
			duplicateBlock(database, preset.id, history.id),
		);
		const duplicated = readStoredRecipe(database, preset.id);
		expect(duplicated.slots.map((slot) => slot.reference)).toEqual([
			"model-post-history-instruction",
			"model-system-instruction",
			"human-identity",
			"model-identity",
			"model-scenario",
			"model-example-dialogue",
			"lore",
			"memory",
			"history",
			"history",
		]);
		expect(slotOf(duplicated, "history", 0)?.id).not.toBe(slotOf(duplicated, "history", 1)?.id);

		// Add a fresh Scenario occurrence: a deliberate duplicate the recipe
		// keeps alongside the disabled original.
		await readOperation(addBlock(database, preset.id, "model-scenario"));
		const added = readStoredRecipe(database, preset.id);
		const addedSlot = added.slots.at(-1);
		expect(addedSlot?.reference).toBe("model-scenario");
		if (addedSlot?.reference !== "model-scenario") throw new Error("The added Scenario is missing.");
		expect(addedSlot.enabled).toBe(true);
		expect(addedSlot.role).toBe("system");

		// A fresh read reports exactly the saved state.
		const reread = await readPreset(app, conversation.id);
		expect(reread.slots.map((slot) => [slot.reference, slot.enabled])).toEqual([
			["model-post-history-instruction", true],
			["model-system-instruction", true],
			["human-identity", true],
			["model-identity", true],
			["model-scenario", false],
			["model-example-dialogue", true],
			["lore", true],
			["memory", true],
			["history", true],
			["history", true],
			["model-scenario", true],
		]);

		let captured: CapturedRequest | undefined;
		const generating = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch((request) => { captured = request; }),
		});
		const generationId = await startGeneration(generating, conversation.id, conversation.revision);
		await completeGeneration(generating, conversation.id, generationId);
		while (captured === undefined) await new Promise((resolve) => setTimeout(resolve, 0));

		// The request honors the saved order, the omitted slot, and the
		// deliberately repeated history and Scenario.
		expect(captured?.messages).toEqual([
			{ role: "system", content: "Continue." },
			{ role: "system", content: "Answer briefly." },
			{ role: "user", content: "I write as Writer opposite Maren." },
			{ role: "assistant", content: "I am Maren." },
			{ role: "user", content: "Writer: Hello\nMaren: Hello back" },
			{ role: "user", content: "Writer: Set the scene." },
			{ role: "user", content: "Writer: Set the scene." },
			{ role: "system", content: "A quiet room." },
		]);

		// Removing the added Scenario occurrence leaves the disabled original
		// and the repeated history exactly where they were.
		const addedForRemoval = added.slots.at(-1);
		if (addedForRemoval === undefined) throw new Error("The added slot disappeared.");
		await readOperation(
			removeBlock(database, preset.id, addedForRemoval.id),
		);
		const removed = readStoredRecipe(database, preset.id);
		expect(removed.slots.map((slot) => [slot.reference, slot.enabled])).toEqual([
			["model-post-history-instruction", true],
			["model-system-instruction", true],
			["human-identity", true],
			["model-identity", true],
			["model-scenario", false],
			["model-example-dialogue", true],
			["lore", true],
			["memory", true],
			["history", true],
			["history", true],
		]);
	});

	test("a saved outgoing role translates the referenced content in the model request", async () => {
		const conversation = createChat(database);
		withProfile(database);
		const app = createConversationRoutes(database);
		const preset = await readPreset(app, conversation.id);
		const scenario = slotOf(preset, "model-scenario");
		const identity = slotOf(preset, "model-identity");
		if (scenario === undefined || identity === undefined) {
			throw new Error("The Default recipe is missing its reference slots.");
		}

		// The Scenario is presented as user content and the model Identity as
		// system content. The role is presentation only: the source text and
		// the Participant supplying it stay untouched.
		await readOperation(
			saveBlockRole(database, preset.id, scenario.id, "user"),
		);
		const withRoles = readStoredRecipe(database, preset.id);
		await readOperation(
			saveBlockRole(database, preset.id, identity.id, "system"),
		);
		const afterIdentity = readStoredRecipe(database, preset.id);
		expect(slotOf(withRoles, "model-scenario")?.role).toBe("user");
		expect(slotOf(afterIdentity, "model-identity")?.role).toBe("system");

		// The Participant Definition was never rewritten.
		const summaryResponse = await app.handle(
			new Request(`http://localhost/api/conversations/${conversation.id}`),
		);
		// SAFETY: the route's response schema is the Conversation summary.
		const summary = await summaryResponse.json() as {
			cast: { name: string; prompt: { identity: string; scenario: string } }[];
		};
		expect(summary.cast.find((participant) => participant.name === "Maren")?.prompt)
			.toEqual(modelPrompt);

		let captured: CapturedRequest | undefined;
		const generating = createConversationRoutes(database, {
			masterKey: key,
			fetch: captureModelFetch((request) => { captured = request; }),
		});
		const generationId = await startGeneration(generating, conversation.id, conversation.revision);
		await completeGeneration(generating, conversation.id, generationId);
		while (captured === undefined) await new Promise((resolve) => setTimeout(resolve, 0));

		expect(captured?.messages).toEqual([
			{ role: "system", content: "Answer briefly." },
			{ role: "user", content: "I write as Writer opposite Maren." },
			{ role: "system", content: "I am Maren." },
			{ role: "user", content: "A quiet room." },
			{ role: "user", content: "Writer: Hello\nMaren: Hello back" },
			{ role: "user", content: "Writer: Set the scene." },
			{ role: "system", content: "Continue." },
		]);
	});

	test("saving one occurrence's role never overwrites separately saved ordering or toggles", async () => {
		const conversation = createChat(database);
		const app = createConversationRoutes(database);
		const preset = await readPreset(app, conversation.id);
		const identity = slotOf(preset, "model-identity");
		const scenario = slotOf(preset, "model-scenario");
		const example = slotOf(preset, "model-example-dialogue");
		if (identity === undefined || scenario === undefined || example === undefined) {
			throw new Error("The Default recipe is missing its reference slots.");
		}

		await readOperation(toggleBlock(database, preset.id, scenario.id, false));
		await readOperation(moveBlock(database, preset.id, example.id, 1));
		await readOperation(saveBlockRole(database, preset.id, identity.id, "user"));

		// The role save named one occurrence; the other saved changes stand.
		const reread = await readPreset(app, conversation.id);
		expect(reread.slots.map((slot) => [slot.reference, slot.enabled])).toEqual([
			["model-example-dialogue", true],
			["model-system-instruction", true],
			["human-identity", true],
			["model-identity", true],
			["model-scenario", false],
			["lore", true],
			["memory", true],
			["history", true],
			["model-post-history-instruction", true],
		]);
		expect(slotOf(reread, "model-identity")?.role).toBe("user");
		expect(slotOf(reread, "model-scenario")?.role).toBe("system");
	});

	test("rejects a role save on a history occurrence", async () => {
		const conversation = createChat(database);
		const preset = await readPreset(createConversationRoutes(database), conversation.id);
		const history = slotOf(preset, "history");
		if (history === undefined) throw new Error("The Default recipe has no history slot.");

		const response = await saveBlockRole(database, preset.id, history.id, "user");
		expect(response.status).toBe(422);
		// SAFETY: the route's typed invalid outcome.
		const outcome = await response.json() as { outcome: string; reason: string };
		expect(outcome.outcome).toBe("invalid");
		expect(outcome.reason).toContain("history");
	});

	test("returns not-found for an unknown preset or block", async () => {
		const response = await addBlock(database, 424242, "model-scenario");
		expect(response.status).toBe(404);

		const conversation = createChat(database);
		const preset = await readPreset(createConversationRoutes(database), conversation.id);
		const missingBlock = await toggleBlock(database, preset.id, 987654, false);
		expect(missingBlock.status).toBe(404);
	});

	test("rejects adding a second Lore block after disabling the existing one", async () => {
		const conversation = createChat(database);
		const preset = await readPreset(createConversationRoutes(database), conversation.id);
		const lore = slotOf(preset, "lore");
		if (lore === undefined) throw new Error("The Default recipe has no Lore block.");

		await readOperation(toggleBlock(database, preset.id, lore.id, false));
		const response = await addBlock(database, preset.id, "lore");
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({ outcome: "invalid" });
	});

	test("rejects adding a second Memory block after disabling the existing one", async () => {
		const conversation = createChat(database);
		const preset = await readPreset(createConversationRoutes(database), conversation.id);
		const memory = slotOf(preset, "memory");
		if (memory === undefined) throw new Error("The Default recipe has no Memory block.");
		await readOperation(toggleBlock(database, preset.id, memory.id, false));
		const response = await addBlock(database, preset.id, "memory");
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({ outcome: "invalid" });
	});
});

describe("Prompt Preset block patch batch", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	// ==[HUMAN APPROVED]== The batch route addresses stored occurrences, so the fixture seeds one
	// authored instruction beside the Default recipe's referenced slots.
	const seedSlots = () => {
		createChat(database);
		const stored = addPromptPresetInstruction(database, 1);
		const instruction = stored.slots.find((slot) => slot.reference === "instruction");
		const identity = stored.slots.find((slot) => slot.reference === "human-identity");
		if (instruction === undefined || identity === undefined) {
			throw new Error("The Default recipe is missing its slots.");
		}
		return { stored, instruction, identity };
	};

	test("saves an occurrence-addressed batch and reads the applied recipe", async () => {
		const { stored, instruction, identity } = seedSlots();

		const response = await saveBlockPatches(database, 1, [
			{ occurrenceId: identity.id, type: "role", role: "assistant" },
			{
				occurrenceId: instruction.id,
				type: "content",
				name: "Tone",
				content: "Be concise.",
				role: "user",
			},
		]);

		expect(response.status).toBe(200);
		// SAFETY: successful recipe mutations return the minimal applied acknowledgment.
		expect(await response.json()).toEqual({ outcome: "applied" });
		const saved = readPromptPresetRecipe(database, 1);
		if (saved === undefined) throw new Error("The saved recipe is missing.");
		expect(slotOf(saved, "human-identity")?.role).toBe("assistant");
		expect(slotOf(saved, "instruction")).toMatchObject({
			name: "Tone",
			content: "Be concise.",
			role: "user",
		});
		// The batch changed only the addressed fields, never the stored order.
		expect(saved.slots.map((slot) => slot.id)).toEqual(stored.slots.map((slot) => slot.id));
	});

	test("treats an empty batch as a successful no-op", async () => {
		const { stored } = seedSlots();

		const response = await saveBlockPatches(database, 1, []);

		expect(response.status).toBe(200);
		// SAFETY: successful recipe mutations return the minimal applied acknowledgment.
		expect(await response.json()).toEqual({ outcome: "applied" });
		const saved = readPromptPresetRecipe(database, 1);
		if (saved === undefined) throw new Error("The saved recipe is missing.");
		expect(saved).toEqual(stored);
	});

	test("rolls back a mixed invalid batch entirely", async () => {
		const { stored, instruction } = seedSlots();

		const response = await saveBlockPatches(database, 1, [
			{
				occurrenceId: instruction.id,
				type: "content",
				name: "Should not persist",
				content: "Nope",
				role: "system",
			},
			{ occurrenceId: 999999, type: "role", role: "system" },
		]);

		expect(response.status).toBe(422);
		// SAFETY: the recipe route's shared invalid envelope carries the reason.
		const outcome = await response.json() as { outcome: string; reason: string };
		expect(outcome.outcome).toBe("invalid");
		expect(outcome.reason).toContain("does not belong");
		expect(readPromptPresetRecipe(database, 1)).toEqual(stored);
	});

	test("refuses a batch that patches one occurrence twice", async () => {
		const { stored, identity } = seedSlots();

		const response = await saveBlockPatches(database, 1, [
			{ occurrenceId: identity.id, type: "role", role: "assistant" },
			{ occurrenceId: identity.id, type: "role", role: "user" },
		]);

		expect(response.status).toBe(422);
		// SAFETY: the recipe route's shared invalid envelope carries the reason.
		const outcome = await response.json() as { outcome: string; reason: string };
		expect(outcome.outcome).toBe("invalid");
		expect(outcome.reason).toContain("more than once");
		expect(readPromptPresetRecipe(database, 1)).toEqual(stored);
	});

	test("returns not-found when the preset is missing, for empty and nonempty batches", async () => {
		const empty = await saveBlockPatches(database, 424242, []);
		expect(empty.status).toBe(404);
		// SAFETY: the recipe route's shared not-found envelope.
		expect(await empty.json()).toEqual({ outcome: "not-found" });

		const nonempty = await saveBlockPatches(database, 424242, [
			{ occurrenceId: 999999, type: "role", role: "system" },
		]);
		expect(nonempty.status).toBe(404);
		expect(await nonempty.json()).toEqual({ outcome: "not-found" });
	});

	test("returns not-found when the preset was deleted after the draft was made", async () => {
		const created = executePromptPresetCommand(database, { type: "create", name: "Disposable" });
		if (created.kind !== "preset") throw new Error("The Disposable preset was not created.");
		const deleted = executePromptPresetCommand(database, {
			type: "delete",
			presetId: created.preset.id,
			expectedRevision: 0,
			expectedConversationCount: 0,
		});
		if (deleted.kind !== "deleted") throw new Error("The Disposable preset was not deleted.");

		const response = await saveBlockPatches(database, created.preset.id, [
			{ occurrenceId: 999999, type: "role", role: "system" },
		]);

		expect(response.status).toBe(404);
		// SAFETY: the recipe route's shared not-found envelope.
		expect(await response.json()).toEqual({ outcome: "not-found" });
	});
});

describe("Prompt Preset shared Default", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("two Chats resolve their own Participant content through the same shared Default", async () => {
		const first = createChat(database, { human: "Rowan", model: "Sable" });
		const second = createChat(database, { human: "Iris", model: "Quill" });
		const app = createConversationRoutes(database);

		const firstPreset = await readPreset(app, first.id);
		const secondPreset = await readPreset(app, second.id);

		// One shared recipe, two independent resolutions.
		expect(firstPreset.id).toBe(secondPreset.id);
		expect(firstPreset.slots.map((slot) => slot.id)).toEqual(
			secondPreset.slots.map((slot) => slot.id),
		);
		expect(slotOf(firstPreset, "human-identity")?.sourceName).toBe("Rowan");
		expect(slotOf(firstPreset, "model-identity")?.sourceName).toBe("Sable");
		expect(slotOf(secondPreset, "human-identity")?.sourceName).toBe("Iris");
		expect(slotOf(secondPreset, "model-identity")?.sourceName).toBe("Quill");
	});

	test("saved edits to Default reach every Chat that selected it", async () => {
		const first = createChat(database);
		const second = createChat(database);
		const app = createConversationRoutes(database);
		const preset = await readPreset(app, first.id);
		const systemInstruction = slotOf(preset, "model-system-instruction");
		if (systemInstruction === undefined) {
			throw new Error("The Default recipe has no System Instruction slot.");
		}

		await readOperation(toggleBlock(database, preset.id, systemInstruction.id, false));

		// The second Chat reads the same saved recipe; there is no per-Chat
		// override layer.
		const secondPreset = await readPreset(app, second.id);
		expect(slotOf(secondPreset, "model-system-instruction")?.enabled).toBe(false);
	});
});
