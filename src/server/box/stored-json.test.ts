import { afterEach, beforeEach, expect, test } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConversationWithHistory, insertBox } from "../test-fixtures/conversation";
import { putChatValue, readChatValue, readLibraryValue } from "./stored-value";
import { readBoxLifecycles, readBoxSetups, readBoxStates } from "./setup";
import { readRecordSlots } from "./records";
import { readMessageMoves } from "./moves";

let database: Database;
let conversationId: number;
let instance: string;
// eslint-disable-next-line ditzy/no-contract-definition-outside-contract -- Local test Box record schema, not a wire contract.
const record = Type.Object({ score: Type.Integer() });
beforeEach(() => {
	database = openInitializedDatabase({ path: ":memory:" });
	conversationId = createConversationWithHistory(database, { name: "Stored Box values", participants: [] }).id;
	instance = insertBox(database, conversationId, "race");
});
afterEach(() => database.close());

test.each(["{", '{"score":"wrong"}'])("stored library and Chat values locate invalid JSON %s", (value) => {
	database.query("INSERT INTO library_data (namespace, key, value, revision) VALUES ('box:race', 'stats', ?, 1)").run(value);
	database.query("INSERT INTO conversation_data (conversation_id, namespace, key, value) VALUES (?, 'box:race', 'stats', ?)").run(conversationId, value);
	expect(() => readLibraryValue(drizzle(database), "race", "stats", record, { score: 0 })).toThrow("box:race stats");
	expect(() => readChatValue(drizzle(database), conversationId, "race", "stats", record, { score: 0 })).toThrow(`Chat ${conversationId} box:race stats`);
});

test.each(["{", '{"phase":"invalid"}'])("stored setup errors locate invalid JSON %s", (value) => {
	database.query("INSERT INTO conversation_data (conversation_id, namespace, key, value) VALUES (?, 'box:race', 'setup', ?)").run(conversationId, value);
	expect(() => readBoxSetups(drizzle(database), conversationId)).toThrow(`Chat ${conversationId} box:race setup`);
});

test.each(["{", '{"automatic":{"score":"wrong"}}'])("stored record errors locate invalid JSON %s", (value) => {
	database.query("INSERT INTO messages (id, conversation_id, position, timestamp) VALUES (900, ?, 0, 'now')").run(conversationId);
	database.query("INSERT INTO message_variant (id, message_id, position, content, timestamp, selected) VALUES (901, 900, 0, '', 'now', 1)").run();
	database.query("INSERT INTO message_variant_data (message_variant_id, namespace, key, value) VALUES (901, 'box:race', ?, ?)").run(`record:${instance}`, value);
	expect(() => readRecordSlots(drizzle(database), "race", record, instance, [901])).toThrow(`Variant 901 box:race record:${instance}`);
});

test.each(["{", '[{"type":"invalid"}]'])("stored Moves errors locate invalid JSON %s", (value) => {
	database.query("INSERT INTO messages (id, conversation_id, position, timestamp) VALUES (900, ?, 0, 'now')").run(conversationId);
	database.query("INSERT INTO messages_data (message_id, namespace, key, value) VALUES (900, 'box:race', 'moves', ?)").run(value);
	expect(() => readMessageMoves(drizzle(database), [900])).toThrow("Message 900 box:race moves");
});

test.each(["enabled", "instance", "setup"])("a Box keeps no Chat value under the host's %s key", (key) => {
	const db = drizzle(database);
	expect(() => putChatValue(db, conversationId, "race", { key, value: "true" }, () => undefined)).toThrow("belongs to the host");
	expect(() => readChatValue(db, conversationId, "race", key, Type.String(), "")).toThrow("belongs to the host");
	expect(readBoxSetups(db, conversationId).race).toMatchObject({ phase: "setup" });
	expect(readBoxStates(db, conversationId).race).toBe("enabled");
});

test("a Chat value guard sees the revision the write lands on, and an absent Box keeps none", () => {
	const db = drizzle(database);
	const memoryInstance = readBoxLifecycles(db, conversationId).memory!.instance;
	const stored = readChatValue(db, conversationId, "memory", "settings", record, { score: 0 });
	expect(stored.revision).toStartWith(`${memoryInstance}:`);
	const guards: string[] = [];
	putChatValue(db, conversationId, "memory", { key: "settings", value: JSON.stringify({ score: 3 }) }, (current) => guards.push(current.revision));
	putChatValue(db, conversationId, "memory", { key: "settings", value: JSON.stringify({ score: 4 }) }, (current) => guards.push(current.revision));
	expect(guards).toEqual([stored.revision, `${memoryInstance}:1`]);
	expect(readChatValue(db, conversationId, "memory", "settings", record, { score: 0 })).toMatchObject({ score: 4, revision: `${memoryInstance}:2` });

	database.query("DELETE FROM conversation_data WHERE conversation_id = ? AND namespace = 'box:memory'").run(conversationId);
	expect(() => putChatValue(db, conversationId, "memory", { key: "settings", value: "{}" }, () => undefined)).toThrow("is not in this Chat");
});

test("a Box cannot write an undeclared Chat key", () => {
	expect(() => putChatValue(drizzle(database), conversationId, "race", { key: "unknown", value: "{}" }, () => undefined)).toThrow("no declared chat value");
});
