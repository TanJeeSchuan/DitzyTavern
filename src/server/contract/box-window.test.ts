import { openObservedDatabase, createConversationWithHistory, insertBox } from "../test-fixtures/conversation";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { initialWorldClockSetup, worldClockRecord, type WorldClockSetup } from "../../shared/contract/world-clock";
import { digestRead } from "../../shared/contract/box-digest";
import { generationPreview, type ConversationAction } from "../../shared/contract/conversation-schema";
import { readRecordSlots, writeAutomaticRecord } from "../box/records";
import { sha256 } from "../memory/hash";
import { createContract } from ".";
import { acceptConversationTailGeneration } from "../conversation";
import { advanceRace } from "../box/race-engine";
import { fillRaceField, initialRaceSetup } from "../../shared/race-data";

const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
const initial = initialWorldClockSetup;

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
	Value.Decode(digestRead(worldClockRecord), await (await app.handle(new Request(`http://localhost/api/conversations/${id}/boxes/world-clock`))).json());

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
	const response = await saveSetup(app, chat.id, chat.revision, { ...initial, start: "2025-02-31T08:00" });
	expect(response.status).toBe(422);
	expect(await response.json()).toEqual({ outcome: "invalid", reason: "Enter a real calendar date and time, such as 2025-06-01T08:00." });
	expect((await readClock(app, chat.id)).status).toBe("8:00 AM");
});

test("the World Clock runs only while the Chat has it enabled", async () => {
	const chat = createClockChat();
	const app = createContract(database);
	const clocked = async () => (await preview(app, chat.id)).promptPlan.blocks.some((block) => block.kind === "box:world-clock");
	expect(await clocked()).toBe(false);
	expect((await command(app, chat.id, chat.revision, { type: "set-box-state", box: "world-clock", state: "enabled" })).status).toBe(200);
	expect(await clocked()).toBe(true);
	expect((await command(app, chat.id, chat.revision + 1, { type: "set-box-state", box: "world-clock", state: "disabled" })).status).toBe(200);
	expect(await clocked()).toBe(false);
});

test("the window read folds the selected passages and reports the dock status", async () => {
	const chat = createClockChat();
	const app = createContract(database);
	const message = database.query<{ id: number }, [number]>("INSERT INTO messages (conversation_id, position, timestamp) VALUES (?, 1, '2026-01-01') RETURNING id").get(chat.id)!;
	const variant = database.query<{ id: number }, [number, string]>(
		"INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 0, ?, '2026-01-01', 1) RETURNING id",
	).get(message.id, "The lamp turns.")!;
	const read = await readClock(app, chat.id);
	expect(read.status).toBe("8:00 AM");
	expect(read.passages).toEqual([{ messageId: message.id, variantId: variant.id, author: null, content: "The lamp turns.", record: null, overridden: false, digested: false }]);
});

test("the window read reports a missing Chat", async () => {
	const app = createContract(database);
	const response = await app.handle(new Request("http://localhost/api/conversations/424242/boxes/world-clock"));
	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({ outcome: "not-found" });
});

const addPassage = (conversationId: number, content: string) => {
	const message = database.query<{ id: number }, [number]>("INSERT INTO messages (conversation_id, position, timestamp) VALUES (?, 1, '2026-01-01') RETURNING id").get(conversationId);
	if (message === null) throw new Error("The test Message was not inserted.");
	const variant = database.query<{ id: number }, [number, string]>(
		"INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 0, ?, '2026-01-01', 1) RETURNING id",
	).get(message.id, content);
	if (variant === null) throw new Error("The test Variant was not inserted.");
	return { messageId: message.id, variantId: variant.id };
};

test("a stale automatic result does not report the passage as digested", async () => {
	const chat = createClockChat();
	const app = createContract(database);
	const clock = insertBox(database, chat.id, "world-clock");
	const { variantId } = addPassage(chat.id, "The lamp turns.");
	writeAutomaticRecord(drizzle(database), "world-clock", clock, variantId, { minutes: 60, weather: "rain" }, sha256("The lamp turns."));
	expect((await readClock(app, chat.id)).passages[0]?.digested).toBe(true);
	database.run("UPDATE message_variant SET content = ? WHERE id = ?", ["The lamp goes dark.", variantId]);
	const stale = (await readClock(app, chat.id)).passages[0];
	expect(stale?.digested).toBe(false);
	expect(stale?.record).toEqual({ minutes: 60, weather: "rain" });
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

test("a Writer override sets the effective value, survives a later automatic digest, and resets", async () => {
	const chat = createClockChat();
	const app = createContract(database);
	const clock = insertBox(database, chat.id, "world-clock");
	const { messageId, variantId } = addPassage(chat.id, "The lamp turns.");
	writeAutomaticRecord(drizzle(database), "world-clock", clock, variantId, { minutes: 60, weather: "rain" }, sha256("The lamp turns."));

	const override = { minutes: 600, weather: "clear" as const };
	const applied = await command(app, chat.id, chat.revision, { type: "set-box-record", box: "world-clock", messageId, variantId, record: override });
	expect(applied.status).toBe(200);
	expect((await readClock(app, chat.id)).passages[0]).toMatchObject({ record: override, overridden: true });
	// @approved
	//  The override changes the folded clock and never the passage's prose.
	expect((await readClock(app, chat.id)).status).toMatch(/^6:00 PM/);
	expect(database.query<{ content: string }, [number]>("SELECT content FROM message_variant WHERE id = ?").get(variantId)?.content).toBe("The lamp turns.");

	// @approved
	//  A digest still in flight lands after the override and may only fill
	//  `automatic`; the effective value stays the Writer's.
	writeAutomaticRecord(drizzle(database), "world-clock", clock, variantId, { minutes: 120, weather: "storm" }, sha256("The lamp turns."));
	expect((await readClock(app, chat.id)).passages[0]).toMatchObject({ record: override, overridden: true });

	const revision: number = (await applied.json()).conversation.revision;
	const reset = await command(app, chat.id, revision, { type: "reset-box-record", box: "world-clock", messageId, variantId });
	expect(reset.status).toBe(200);
	expect((await readClock(app, chat.id)).passages[0]).toMatchObject({ record: { minutes: 120, weather: "storm" }, overridden: false });
});

test("a Variant still generating takes no Writer override, so its own record can land when it settles", async () => {
	const chat = createClockChat();
	const app = createContract(database);
	insertBox(database, chat.id, "race");
	const [human, model] = chat.cast;
	if (human === undefined || model === undefined) throw new Error("Control Participants missing.");
	const accepted = acceptConversationTailGeneration(database, {
		seed: "override-seed", conversationId: chat.id, expectedRevision: chat.revision, timestamp: "2026-08-27T00:00:00.000Z",
		humanContent: "Go.", humanParticipantId: human.id, modelParticipantId: model.id, capturedModelName: model.name,
		promptPlan: { blocks: [], warnings: [], images: [] }, promptContext: [], generationSettings: {}, connection: {},
	});
	const setup = { ...initialRaceSetup, raceId: "race-a", phase: "running" as const, slots: fillRaceField([], [], "field") };
	const record = advanceRace({ setup, state: null, seed: "stretch", intent: "respond", moves: [] });
	if (record === undefined) throw new Error("The Stretch produced no record.");
	const { messageId, provisionalVariantId: variantId, conversation } = accepted;
	const response = await command(app, chat.id, conversation.revision, { type: "set-box-record", box: "race", messageId, variantId, record });
	expect(await response.json()).toEqual({ outcome: "invalid", reason: "This Variant is still generating. Override its record once it settles." });
});

test("an override outside the Box record schema is refused", async () => {
	const chat = createClockChat();
	const app = createContract(database);
	const clock = insertBox(database, chat.id, "world-clock");
	const { messageId, variantId } = addPassage(chat.id, "The lamp turns.");
	const response = await app.handle(new Request(`http://localhost/api/conversations/${chat.id}/commands`, {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ expectedRevision: chat.revision, action: { type: "set-box-record", box: "world-clock", messageId, variantId, record: { minutes: -5, weather: "storm" } } }),
	}));
	expect(response.status).toBe(422);
	expect(readRecordSlots(drizzle(database), "world-clock", clock, [variantId]).size).toBe(0);
});
