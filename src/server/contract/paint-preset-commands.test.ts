import { expect, test } from "bun:test";
import { importNativePromptPreset } from "../prompt-preset";
import { createConversationWithHistory, openObservedDatabase } from "../test-fixtures/conversation";
import { createConversationRoutes } from "./conversation";
import { createPaintingRoutes } from "./painting";

test("Paint Preset and Brief Message count writes require the current Chat revision", async () => {
	using database = openObservedDatabase();
	const chat = createConversationWithHistory(database, { name: "Paint" });
	const preset = importNativePromptPreset(database, { name: "Charcoal", slots: [{ reference: "brief-instruction", enabled: true, role: "system", content: "Use charcoal." }] });
	const app = createConversationRoutes(database).use(createPaintingRoutes(database));
	const url = `http://localhost/api/conversations/${chat.id}`;
	const select = { type: "select-paint-preset", paintPresetId: preset.id };
	const setCount = { type: "set-brief-message-count", briefMessageCount: 2 };
	type Action = typeof select | typeof setCount;
	const post = (path: string, body: Action | { expectedRevision: number; action: Action }) => app.handle(new Request(`${url}${path}`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
	}));

	for (const action of [select, setCount]) {
		expect((await post("/illustrations/commands", action)).status).toBe(422);
	}
	const selected = await post("/commands", { expectedRevision: chat.revision, action: select });
	expect(selected.status).toBe(200);
	expect(await selected.json()).toMatchObject({ conversation: { revision: chat.revision + 1 } });

	const stale = await post("/commands", { expectedRevision: chat.revision, action: setCount });
	expect(stale.status).toBe(409);
	expect(await stale.json()).toMatchObject({ outcome: "conflict", reason: "stale-revision", expectedRevision: chat.revision, actualRevision: chat.revision + 1 });
	const settings = async () => (await app.handle(new Request(`${url}/illustrations`))).json();
	expect(await settings()).toMatchObject({ paintPresetId: preset.id, briefMessageCount: 5 });

	const updated = await post("/commands", { expectedRevision: chat.revision + 1, action: setCount });
	expect(updated.status).toBe(200);
	expect(await updated.json()).toMatchObject({ conversation: { revision: chat.revision + 2 } });
	expect(await settings()).toMatchObject({ briefMessageCount: 2 });
});
