import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openObservedDatabase, createConversationWithHistory, insertBox } from "../../server/test-fixtures/conversation";
import { createContract } from "../../server/contract";
import { writeAutomaticRecord } from "../../server/box/records";
import { sha256 } from "../../server/hash";
import { digestRead } from "../../shared/contract/box-digest";
import { initialWorldClockSetup, worldClockRecord } from "./contract";

let database: Database;
beforeEach(() => { database = openObservedDatabase(); });
afterEach(() => database.close());
const initial = initialWorldClockSetup;
const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
const createClockChat = () => createConversationWithHistory(database, {
	name: "Clock Chat",
	participants: [{ definition: { name: "Writer", prompt, openings: [] } }, { definition: { name: "Maren", prompt, openings: [] } }],
	control: { human: 0, model: 1 },
});
const saveSetup = (app: ReturnType<typeof createContract>, id: number, revision: number, setup: typeof initial) =>
	app.handle(new Request(`http://localhost/api/conversations/${id}/commands`, {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ expectedRevision: revision, action: { type: "set-box-setup", box: "world-clock", setup } }),
	}));
const readClock = async (app: ReturnType<typeof createContract>, id: number) =>
	Value.Decode(digestRead(worldClockRecord), await (await app.handle(new Request(`http://localhost/api/conversations/${id}/boxes/world-clock`))).json());

const addPassage = (conversationId: number, content: string) => {
	const message = database.query<{ id: number }, [number]>("INSERT INTO messages (conversation_id, position, timestamp) VALUES (?, 1, '2026-01-01') RETURNING id").get(conversationId);
	if (message === null) throw new Error("The test Message was not inserted.");
	const variant = database.query<{ id: number }, [number, string]>(
		"INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 0, ?, '2026-01-01', 1) RETURNING id",
	).get(message.id, content);
	if (variant === null) throw new Error("The test Variant was not inserted.");
	return { messageId: message.id, variantId: variant.id };
};

test("an impossible calendar date is rejected instead of rolling into the next month", async () => {
	const chat = createClockChat();
	const app = createContract(database);
	insertBox(database, chat.id, "world-clock");
	const response = await saveSetup(app, chat.id, chat.revision, { ...initial, start: "2025-02-31T08:00" });
	expect(response.status).toBe(422);
	expect(await response.json()).toEqual({ outcome: "invalid", reason: "Enter a real calendar date and time, such as 2025-06-01T08:00." });
	expect((await readClock(app, chat.id)).status).toBe("8:00 AM");
});

test("a passage whose prose was cleared leaves the timeline but keeps its record in the status, as in the prompt", async () => {
	const chat = createClockChat();
	const app = createContract(database);
	const clock = insertBox(database, chat.id, "world-clock");
	const { variantId } = addPassage(chat.id, "The lamp turns.");
	writeAutomaticRecord(drizzle(database), "world-clock", clock, variantId, { minutes: 60, weather: null }, sha256("The lamp turns."));
	database.run("UPDATE message_variant SET content = '' WHERE id = ?", [variantId]);
	const read = await readClock(app, chat.id);
	expect(read.passages).toEqual([]);
	expect(read.status).toBe("9:00 AM");
	expect(await (await app.handle(new Request(`http://localhost/api/conversations/${chat.id}/boxes/world-clock/status`))).json()).toEqual({ status: "9:00 AM" });
});
