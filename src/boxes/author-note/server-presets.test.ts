import { openObservedDatabase } from "../../server/test-fixtures/conversation";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
	addBlock,
	appliedId,
	createRoutes,
	exportPreset,
	importPreset,
	readOperation,
	saveBlockRole,
	toggleBlock,
	listPresets,
	createChat,
	selectPreset,
	readPreset,
} from "../../server/contract/prompt-preset-test-fixtures";

let database: Database;
beforeEach(() => {
	database = openObservedDatabase();
});
afterEach(() => database.close());

test("Add Author Note Block preserves the recipe and inserts after its last history slot", async () => {
	const { library } = createRoutes(database);
	const id = appliedId(await importPreset(library, { name: "Older recipe", slots: [
		{ reference: "history", enabled: true },
		{ reference: "model-identity", enabled: true, role: "assistant" },
		{ reference: "history", enabled: false },
		{ reference: "model-post-history-instruction", enabled: true, role: "user" },
	] }));
	expect((await exportPreset(library, id)).slots).toHaveLength(4);
	await readOperation(addBlock(database, id, "box:author-note"));
	expect(await exportPreset(library, id)).toEqual({ name: "Older recipe", slots: [
		{ reference: "history", enabled: true },
		{ reference: "model-identity", enabled: true, role: "assistant" },
		{ reference: "history", enabled: false },
		{ reference: "box:author-note", enabled: true, role: "system", content: "" },
		{ reference: "model-post-history-instruction", enabled: true, role: "user" },
	] });
});

test("Add Author Note Block appends when the recipe has no history", async () => {
	const { library } = createRoutes(database);
	const id = appliedId(await importPreset(library, { name: "No history", slots: [{ reference: "model-identity", enabled: false, role: "user" }] }));
	await readOperation(addBlock(database, id, "box:author-note"));
	expect((await exportPreset(library, id)).slots).toEqual([
		{ reference: "model-identity", enabled: false, role: "user" },
		{ reference: "box:author-note", enabled: true, role: "system", content: "" },
	]);
});

test("Add Author Note Block refuses an existing disabled slot without changing the recipe", async () => {
	const { library } = createRoutes(database);
	const id = appliedId(await importPreset(library, { name: "Disabled note", slots: [{ reference: "box:author-note", enabled: false, role: "assistant", content: "" }] }));
	const response = await addBlock(database, id, "box:author-note");
	expect(response.status).toBe(422);
	expect(await response.json()).toEqual({ outcome: "invalid", reason: "A Prompt Preset may contain at most one Author Note block." });
	expect((await exportPreset(library, id)).slots).toEqual([{ reference: "box:author-note", enabled: false, role: "assistant", content: "" }]);
});


test("native export and reimport keep the Author Note position, role and enablement", async () => {
	const { library, conversations } = createRoutes(database);
	const chat = createChat(database);
	const id = appliedId(await importPreset(library, { name: "Shared recipe", slots: [
		{ reference: "history", enabled: true },
		{ reference: "model-post-history-instruction", enabled: true, role: "system" },
	] }));
	await readOperation(addBlock(database, id, "box:author-note"));
	await selectPreset(conversations, chat.id, chat.revision, id);
	const recipe = await readPreset(conversations, chat.id);
	const note = recipe.slots.find((slot) => slot.reference === "box:author-note")!;
	await readOperation(saveBlockRole(database, id, note.id, "user"));
	await readOperation(toggleBlock(database, id, note.id, false));
	const exported = await exportPreset(library, id);
	expect(exported).toEqual({ name: "Shared recipe", slots: [
		{ reference: "history", enabled: true },
		{ reference: "box:author-note", enabled: false, role: "user", content: "" },
		{ reference: "model-post-history-instruction", enabled: true, role: "system" },
	] });
	expect(await exportPreset(library, appliedId(await importPreset(library, exported)))).toEqual(exported);
});

test.each([true, false])("native import rejects duplicate Author Note slots even when enabled is %s", async (enabled) => {
	const { library } = createRoutes(database);
	const imported = await importPreset(library, { name: "Duplicate note", slots: [
		{ reference: "box:author-note", enabled, role: "system", content: "" },
		{ reference: "box:author-note", enabled: false, role: "assistant", content: "" },
	] });
	expect(imported).toEqual({ status: 422, body: { outcome: "invalid", reason: "A Prompt Preset may contain at most one Author Note block." } });
	expect(await listPresets(library)).toHaveLength(3);
});
