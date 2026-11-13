import { executeConversationCommand } from "../conversation";
import { importNativePromptPreset } from "../prompt-preset";
import { withProfile, conversationApp, captureModelFetch, startGeneration, completeGeneration, createChat, recipeRoutes, readStoredRecipe, duplicateBlock } from "./prompt-preset-test-fixtures";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { openObservedDatabase } from "../test-fixtures/conversation";

let database: ReturnType<typeof openObservedDatabase>;
beforeEach(() => { database = openObservedDatabase(); });
afterEach(() => database.close());

test("a Brief instruction saves authored text and role and refuses a second occurrence", async () => {
	createChat(database);
	const app = recipeRoutes(database);
	const add = () => app.handle(new Request("http://localhost/api/prompt-presets/1/blocks", {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reference: "brief-instruction" }),
	}));
	expect((await add()).status).toBe(200);
	const slot = readStoredRecipe(database, 1).slots.find((slot) => slot.reference === "brief-instruction");
	if (!slot) throw new Error("Brief instruction missing");
	expect(slot).toMatchObject({ role: "user" });
	const saved = await app.handle(new Request("http://localhost/api/prompt-presets/1/blocks/patches", {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ patches: [{ occurrenceId: slot.id, type: "content", content: "Describe the scene in charcoal.", role: "user" }] }),
	}));
	expect(saved.status).toBe(200);
	expect(readStoredRecipe(database, 1).slots.find((entry) => entry.id === slot.id)).toMatchObject({ content: "Describe the scene in charcoal.", role: "user" });
	expect((await add()).status).toBe(422);
	expect((await duplicateBlock(database, 1, slot.id)).status).toBe(422);
});

test("a Generation skips an enabled Brief instruction on its story preset", async () => {
	const chat = createChat(database);
	withProfile(database);
	const preset = importNativePromptPreset(database, { name: "Both", slots: [
		{ reference: "history", enabled: true },
		{ reference: "instruction", enabled: true, role: "system", name: "Story", content: "Tell the story." },
		{ reference: "brief-instruction", enabled: true, role: "user", content: "Only for painting." },
	] });
	const selected = executeConversationCommand(database, { conversationId: chat.id, expectedRevision: chat.revision, action: { type: "select-prompt-preset", promptPresetId: preset.id } });
	const requests: unknown[] = [];
	const app = conversationApp(database, { masterKey: new Uint8Array(32).fill(11), fetch: captureModelFetch((request) => requests.push(request)) });
	await completeGeneration(app, chat.id, await startGeneration(app, chat.id, selected.revision));
	expect(JSON.stringify(requests)).toContain("Tell the story.");
	expect(JSON.stringify(requests)).not.toContain("Only for painting.");
});
