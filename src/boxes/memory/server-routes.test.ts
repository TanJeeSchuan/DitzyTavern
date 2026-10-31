import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import { openInitializedDatabase } from "../../server/database/database";
import { messageTable, messageVariantTable } from "../../server/database/schema";
import { createChat } from "../../server/contract/prompt-preset-test-fixtures";
import { memoryRoutes } from "./server-routes";
import { memorySources, type MemoryRecord } from "./contract";

import { readBoxLifecycles } from "../../server/box/setup";
import { resetWriterRecord, writeAutomaticRecord, writeWriterRecord } from "../../server/box/records";

let database: Database;
beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
afterEach(() => database.close());

const passage = (conversationId: number, position: number) => {
	const db = drizzle(database);
	const message = db.insert(messageTable).values({ conversation_id: conversationId, position, timestamp: "2026-10-13T00:00:00Z" }).returning().get();
	const variant = db.insert(messageVariantTable).values({ message_id: message.id, position: 0, timestamp: message.timestamp, content: "Maren kept the key.", selected: true }).returning().get();
	return { messageId: message.id, variantId: variant.id };
};

test("a trace's view links only to the Messages and Variants still in its Chat", async () => {
	const chat = createChat(database);
	const kept = passage(chat.id, 1);
	const edited = passage(chat.id, 2);
	const foreign = passage(createChat(database).id, 1);
	database.run("DELETE FROM message_variant WHERE id = ?", [edited.variantId]);
	const ids = (...values: number[]) => values.join(",");
	const response = await memoryRoutes(database).handle(new Request(`http://localhost/conversations/${chat.id}/memories/sources?messageIds=${ids(kept.messageId, edited.messageId, foreign.messageId)}&variantIds=${ids(kept.variantId, edited.variantId, foreign.variantId)}`));
	const sources = Value.Parse(memorySources, await response.json());
	expect({ messageIds: sources.messageIds.toSorted(), variantIds: sources.variantIds }).toEqual({ messageIds: [kept.messageId, edited.messageId].toSorted(), variantIds: [kept.variantId] });
	const none = await memoryRoutes(database).handle(new Request(`http://localhost/conversations/${chat.id}/memories/sources?messageIds=&variantIds=`));
	expect(await none.json()).toEqual({ messageIds: [], variantIds: [], records: [] });
});


test("trace sources resolve effective records, detect corrections and reset, and exclude another Chat", async () => {
	const chat = createChat(database);
	const source = passage(chat.id, 1);
	const evidence = passage(chat.id, 2);
	const foreign = passage(createChat(database).id, 1);
	const db = drizzle(database);
	const instance = readBoxLifecycles(db, chat.id).memory!.instance;
	const automatic: MemoryRecord = { claims: [{
		claim: "Maren kept the key.", attribution: "Narrated event", people: ["Maren"],
		evidence: [{ messageId: evidence.messageId, excerpt: "The key was in Maren's pocket." }],
		judgment: { support: "supported", attribution: "correct", usefulness: "retain", probabilities: {}, confidence: {} },
	}] };
	writeAutomaticRecord(db, "memory", instance, source.variantId, automatic, "source");
	writeWriterRecord(db, "memory", instance, foreign.variantId, automatic);
	const read = async () => Value.Parse(memorySources, await (await memoryRoutes(database).handle(new Request(`http://localhost/conversations/${chat.id}/memories/sources?messageIds=${source.messageId}&variantIds=${source.variantId},${foreign.variantId}`))).json());
	const original = await read();
	expect(original.records).toMatchObject([{ variantId: source.variantId, claims: [{ claim: "Maren kept the key.", evidence: automatic.claims[0]!.evidence }] }]);
	expect(original.messageIds).toContain(evidence.messageId);
	writeWriterRecord(db, "memory", instance, source.variantId, { claims: automatic.claims.map((claim) => ({ ...claim, claim: "Maren lost the key." })) });
	const corrected = await read();
	expect(corrected.records[0]?.claims[0]?.claim).toBe("Maren lost the key.");
	expect(corrected.records[0]?.fingerprint).not.toBe(original.records[0]?.fingerprint);
	resetWriterRecord(db, "memory", instance, source.variantId);
	expect((await read()).records).toEqual(original.records);
	const forked = passage(chat.id, 3);
	writeAutomaticRecord(db, "memory", instance, forked.variantId, { claims: automatic.claims.map((claim) => ({ ...claim, evidence: [{ ...claim.evidence[0]!, messageId: forked.messageId }] })) }, "source");
	const forkRead = await memoryRoutes(database).handle(new Request(`http://localhost/conversations/${chat.id}/memories/sources?messageIds=&variantIds=${forked.variantId}`));
	expect(Value.Parse(memorySources, await forkRead.json()).records[0]?.fingerprint).toBe(original.records[0]?.fingerprint);
	database.run("DELETE FROM message_variant WHERE id = ?", [source.variantId]);
	expect((await read()).records).toEqual([]);
});
