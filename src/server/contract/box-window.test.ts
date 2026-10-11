import { openObservedDatabase, createConversationWithHistory } from "../test-fixtures/conversation";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import type { Database } from "bun:sqlite";
import { worldClockRead, type WorldClockSetup } from "../../shared/contract/box";
import { generationPreview, type ConversationAction } from "../../shared/contract/conversation-schema";
import { worldClockBox } from "../box/world-clock";
import { createContract } from ".";

const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
const initial = worldClockBox.setup.initial;

let database: Database;
beforeEach(() => { database = openObservedDatabase(); });
afterEach(() => database.close());

const createClockChat = () => createConversationWithHistory(database, {
	name: "Clock Chat",
	participants: [
		{ definition: { name: "Writer", prompt, openings: [] } },
		{ definition: { name: "Maren", prompt, openings: [] } },
	],
	control: { human: 0, model: 1 },
});

const command = (app: ReturnType<typeof createContract>, id: number, revision: number, action: ConversationAction) =>
	app.handle(new Request(`http://localhost/api/conversations/${id}/commands`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: revision, action }),
	}));

const saveSetup = (app: ReturnType<typeof createContract>, id: number, revision: number, setup: WorldClockSetup) =>
	command(app, id, revision, { type: "set-box-setup", box: "world-clock", setup });

const readClock = async (app: ReturnType<typeof createContract>, id: number) =>
	Value.Decode(worldClockRead, await (await app.handle(new Request(`http://localhost/api/conversations/${id}/boxes/world-clock`))).json());

const preview = async (app: ReturnType<typeof createContract>, id: number) => {
	const response = await app.handle(new Request(`http://localhost/api/conversations/${id}/generations/preview`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "send", content: "Look outside." }),
	}));
	expect(response.status).toBe(200);
	return Value.Decode(generationPreview, await response.json());
};

test("an impossible calendar date is rejected instead of rolling into the next month", async () => {
	const chat = createClockChat();
	const app = createContract(database);
	const response = await saveSetup(app, chat.id, chat.revision, { ...initial, enabled: true, start: "2025-02-31T08:00" });
	expect(response.status).toBe(422);
	expect(await response.json()).toEqual({ outcome: "invalid", reason: "Enter a real calendar date and time, such as 2025-06-01T08:00." });
	expect((await readClock(app, chat.id)).status).toBe("8:00 AM");
});

test("the World Clock contributes nothing until the Chat turns it on", async () => {
	const chat = createClockChat();
	const app = createContract(database);
	expect((await preview(app, chat.id)).promptPlan.blocks.some((block) => block.kind === "box:world-clock")).toBe(false);
	expect((await saveSetup(app, chat.id, chat.revision, { ...initial, enabled: true })).status).toBe(200);
	expect((await preview(app, chat.id)).promptPlan.blocks.some((block) => block.kind === "box:world-clock")).toBe(true);
});

test("the window read folds the selected passages and reports the dock status", async () => {
	const chat = createClockChat();
	const app = createContract(database);
	const message = database.query<{ id: number }, [number]>("INSERT INTO messages (conversation_id, position, timestamp) VALUES (?, 1, '2026-01-01') RETURNING id").get(chat.id)!;
	const variant = database.query<{ id: number }, [number, string]>("INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 0, ?, '2026-01-01', 1) RETURNING id").get(message.id, "The lamp turns.")!;
	expect((await saveSetup(app, chat.id, chat.revision, { ...initial, enabled: true })).status).toBe(200);
	const read = await readClock(app, chat.id);
	expect(read.status).toBe("8:00 AM");
	expect(read.passages).toEqual([{ messageId: message.id, variantId: variant.id, author: null, content: "The lamp turns.", record: null, overridden: false }]);
});

test("the window read reports a missing Chat", async () => {
	const app = createContract(database);
	const response = await app.handle(new Request("http://localhost/api/conversations/424242/boxes/world-clock"));
	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({ outcome: "not-found" });
});
