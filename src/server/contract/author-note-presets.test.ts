import { openObservedDatabase } from "../conversation/test-fixtures";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { addBlock, createRoutes, exportPreset, importPreset, readOperation, saveBlockRole, toggleBlock, listPresets, createChat, selectPreset, readPreset } from "./prompt-preset-test-fixtures";

let database: Database;
beforeEach(() => {
	database = openObservedDatabase();
});
afterEach(() => database.close());

test("Add Author Note Block preserves the recipe and inserts after its last history slot", async () => {
	const { library } = createRoutes(database);
	await importPreset(library, { name: "Older recipe", slots: [
		{ reference: "history", enabled: true },
		{ reference: "model-identity", enabled: true, role: "assistant" },
		{ reference: "history", enabled: false },
		{ reference: "model-post-history-instruction", enabled: true, role: "user" },
	] });
	expect((await exportPreset(library, 2)).slots).toHaveLength(4);
	await readOperation(addBlock(database, 2, "author-note"));
	expect(await exportPreset(library, 2)).toEqual({ name: "Older recipe", slots: [
		{ reference: "history", enabled: true },
		{ reference: "model-identity", enabled: true, role: "assistant" },
		{ reference: "history", enabled: false },
		{ reference: "author-note", enabled: true, role: "system" },
		{ reference: "model-post-history-instruction", enabled: true, role: "user" },
	] });
});

test("Add Author Note Block appends when the recipe has no history", async () => {
	const { library } = createRoutes(database);
	await importPreset(library, { name: "No history", slots: [{ reference: "model-identity", enabled: false, role: "user" }] });
	await readOperation(addBlock(database, 2, "author-note"));
	expect((await exportPreset(library, 2)).slots).toEqual([
		{ reference: "model-identity", enabled: false, role: "user" },
		{ reference: "author-note", enabled: true, role: "system" },
	]);
});

test("Add Author Note Block refuses an existing disabled slot without changing the recipe", async () => {
	const { library } = createRoutes(database);
	await importPreset(library, { name: "Disabled note", slots: [{ reference: "author-note", enabled: false, role: "assistant" }] });
	const response = await addBlock(database, 2, "author-note");
	expect(response.status).toBe(422);
	expect(await response.json()).toEqual({ outcome: "invalid", reason: "A Prompt Preset may contain at most one Author Note block." });
	expect((await exportPreset(library, 2)).slots).toEqual([{ reference: "author-note", enabled: false, role: "assistant" }]);
});


test("native export and reimport keep the Author Note position, role and enablement", async () => {
	const { library, conversations } = createRoutes(database);
	const chat = createChat(database);
	await importPreset(library, { name: "Shared recipe", slots: [
		{ reference: "history", enabled: true },
		{ reference: "model-post-history-instruction", enabled: true, role: "system" },
	] });
	await readOperation(addBlock(database, 2, "author-note"));
	await selectPreset(conversations, chat.id, chat.revision, 2);
	const recipe = await readPreset(conversations, chat.id);
	const note = recipe.slots.find((slot) => slot.reference === "author-note")!;
	await readOperation(saveBlockRole(database, 2, note.id, "user"));
	await readOperation(toggleBlock(database, 2, note.id, false));
	const exported = await exportPreset(library, 2);
	expect(exported).toEqual({ name: "Shared recipe", slots: [
		{ reference: "history", enabled: true },
		{ reference: "author-note", enabled: false, role: "user" },
		{ reference: "model-post-history-instruction", enabled: true, role: "system" },
	] });
	expect((await importPreset(library, exported)).status).toBe(200);
	expect(await exportPreset(library, 3)).toEqual(exported);
});

test.each([true, false])("native import rejects duplicate Author Note slots even when enabled is %s", async (enabled) => {
	const { library } = createRoutes(database);
	const imported = await importPreset(library, { name: "Duplicate note", slots: [
		{ reference: "author-note", enabled, role: "system" },
		{ reference: "author-note", enabled: false, role: "assistant" },
	] });
	expect(imported).toEqual({ status: 422, body: { outcome: "invalid", reason: "A Prompt Preset may contain at most one Author Note block." } });
	expect(await listPresets(library)).toHaveLength(1);
});
