import { boxDescriptor } from "../../shared/contract/box";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openInitializedDatabase } from "../../server/database/database";
import { createChat } from "../../server/contract/prompt-preset-test-fixtures";
import { messageTable, messageVariantTable } from "../../server/database/schema";
import { sha256 } from "../../server/hash";
import { writeAutomaticRecord, writeWriterRecord } from "../../server/box/records";
import { readBoxLifecycles } from "../../server/box/setup";
import { boxExports } from "../../server/box/exports";
import { memoryRoutes } from "./server-routes";
import { readMemoryLabelState } from "./server-chat";
import type { MemoryCandidateJudgment } from "./contract";

/** One Claim as the Exports answer it: the stored claim beside the Message that holds it. */
const claimOf = (messageId: number, people: string[], claim = "Alice promised Bob a key.") => ({
	messageId, claim, attribution: "Alice said it.", people, evidence: [{ messageId, excerpt: "I promised Bob a key." }],
});
const candidate = (messageId: number, people: string[], claim?: string): MemoryCandidateJudgment => ({
	...claimOf(messageId, people, claim), judgment: { support: "supported", attribution: "correct", usefulness: "retain", probabilities: {}, confidence: { support: 1, attribution: 1, usefulness: 1 } },
});

const addSource = (database: Database, conversationId: number, position: number, people: string[], selected = true) => {
	const db = drizzle(database);
	const message = db.insert(messageTable).values({ conversation_id: conversationId, position, timestamp: "2026-09-29T00:00:00Z", author_name: "Alice" }).returning().get();
	const variant = db.insert(messageVariantTable).values({ message_id: message.id, position: 0, timestamp: message.timestamp, content: "I promised Bob a key.", selected }).returning().get();
	writeAutomaticRecord(db, boxDescriptor("memory"), readBoxLifecycles(db, conversationId).memory!.instance, variant.id, { claims: [candidate(message.id, people)] }, sha256(variant.content));
	return { messageId: message.id, variantId: variant.id };
};

const merge = (database: Database, conversationId: number, labels: string[], destination: string) =>
	memoryRoutes(database).handle(new Request(`http://localhost/conversations/${conversationId}/memories/merge-labels`, {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ labels, destination, expectedRevision: readMemoryLabelState(database, conversationId).revision }),
	}));

/** The Chat's Memory Exports, refusing a Chat that lost them. */
const exportsOf = (database: Database, conversationId: number) => {
	const { people, claimsAbout } = boxExports(database, conversationId).memory ?? {};
	if (people === undefined || claimsAbout === undefined) throw new Error("Memory's Exports are missing.");
	return { people, claimsAbout };
};

describe("Memory's Exports", () => {
	let database: Database;
	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("people() lists the labels on the Selected narrative path after label merges, and claimsAbout() returns the Claims whose merged people include the label", async () => {
		const chat = createChat(database);
		const first = addSource(database, chat.id, 1, ["Bob"]);
		const second = addSource(database, chat.id, 2, ["Bob", "Alice"]);
		expect((await merge(database, chat.id, ["Bob"], "Bartholomew Crane")).status).toBe(200);
		const memory = exportsOf(database, chat.id);
		expect(memory.people()).toEqual(["Bartholomew Crane", "Alice"]);
		expect(memory.claimsAbout({ label: "Bartholomew Crane" })).toEqual([
			claimOf(first.messageId, ["Bartholomew Crane"]),
			claimOf(second.messageId, ["Bartholomew Crane", "Alice"]),
		]);
		expect(memory.claimsAbout({ label: "Alice" })).toEqual([claimOf(second.messageId, ["Bartholomew Crane", "Alice"])]);
		expect(memory.claimsAbout({ label: "Bob" })).toEqual([]);
	});

	test("a Writer override's Claims are the ones an Export answers with", () => {
		const chat = createChat(database);
		const source = addSource(database, chat.id, 1, ["Maren"]);
		writeWriterRecord(drizzle(database), boxDescriptor("memory"), readBoxLifecycles(drizzle(database), chat.id).memory!.instance, source.variantId,
			{ claims: [candidate(source.messageId, ["Maren"], "Maren kept the key.")] });
		const memory = exportsOf(database, chat.id);
		expect(memory.people()).toEqual(["Maren"]);
		expect(memory.claimsAbout({ label: "Maren" })).toEqual([claimOf(source.messageId, ["Maren"], "Maren kept the key.")]);
	});

	test("Claims off the Selected narrative path are left out", () => {
		const chat = createChat(database);
		addSource(database, chat.id, 1, ["Bob"]);
		addSource(database, chat.id, 2, ["Eve"], false);
		const memory = exportsOf(database, chat.id);
		expect(memory.people()).toEqual(["Bob"]);
		expect(memory.claimsAbout({ label: "Eve" })).toEqual([]);
	});
});
