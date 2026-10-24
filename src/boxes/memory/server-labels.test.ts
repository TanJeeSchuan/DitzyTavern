import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import { openInitializedDatabase } from "../../server/database/database";
import { insertBox, openObservedDatabase, setBoxState } from "../../server/test-fixtures/conversation";
import { messageTable, messageVariantTable } from "../../server/database/schema";
import { createChat } from "../../server/contract/prompt-preset-test-fixtures";
import { memoryRoutes } from "./server-routes";
import { readConversationMemories, setMemoryAllowance } from "./server-memories";
import { readMemoryChatSettings } from "./server-chat";
import { sha256 } from "../../server/hash";
import { writeAutomaticRecord } from "../../server/box/records";
import { readBoxInstances } from "../../server/box/setup";
import { applyMemoryPeople } from "./shared";
import { memoryLabelsMerged, type ConversationMemories, type MemoryCandidateJudgment } from "./contract";

const memory = (messageId: number, people: string[]): MemoryCandidateJudgment => ({ claim: "Alice promised Bob a key.", attribution: "Alice said it.", people, evidence: [{ messageId, excerpt: "I promised Bob a key." }], judgment: { support: "supported", attribution: "correct", usefulness: "retain", probabilities: {}, confidence: { support: 1, attribution: 1, usefulness: 1 } } });

const addSource = (database: Database, conversationId: number, position: number, people: string[], selected = true) => {
	const db = drizzle(database);
	const message = db.insert(messageTable).values({ conversation_id: conversationId, position, timestamp: "2026-09-29T00:00:00Z", author_name: "Alice" }).returning().get();
	const variant = db.insert(messageVariantTable).values({ message_id: message.id, position: 0, timestamp: message.timestamp, content: "I promised Bob a key.", selected }).returning().get();
	writeAutomaticRecord(db, "memory", readBoxInstances(db, conversationId).memory!, variant.id, { claims: [memory(message.id, people)] }, sha256(variant.content));
	return { messageId: message.id, variantId: variant.id };
};

const merge = (database: Database, conversationId: number, labels: string[], destination: string, expectedRevision = readConversationMemories(database, conversationId).labelRevision) =>
	memoryRoutes(database).handle(new Request(`http://localhost/conversations/${conversationId}/memories/merge-labels`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ labels, destination, expectedRevision }) }));

const shown = (memories: ConversationMemories) => memories.sources.map((source) => source.claims?.map((claim) => applyMemoryPeople(claim.people, memories.cast, memories.identities, memories.labelMerges)));

describe("Memory label merging", () => {
	let database: Database;
	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("a merge keeps the names extraction gave each claim and renames them wherever claims are shown", async () => {
		const chat = createChat(database);
		addSource(database, chat.id, 1, ["assistant", "Assistant", "Bob"]);
		addSource(database, chat.id, 2, ["Assistant"], false);
		const other = createChat(database);
		addSource(database, other.id, 1, ["assistant"]);
		const response = await merge(database, chat.id, ["assistant", "Assistant"], " Alice ");
		expect(response.status).toBe(200);
		const { memories } = Value.Parse(memoryLabelsMerged, await response.json());
		expect(memories.sources.map((source) => source.claims?.[0]?.people)).toEqual([["assistant", "Assistant", "Bob"], ["Assistant"]]);
		expect(shown(memories)).toEqual([[["Alice", "Bob"]], [["Alice"]]]);
		expect(shown(readConversationMemories(database, other.id))).toEqual([[["assistant"]]]);
	});

	test("flattens repeated merges and supports renaming back", async () => {
		const chat = createChat(database);
		addSource(database, chat.id, 1, ["Alice", "Narrator", "Assistant", "Bob"]);
		expect((await merge(database, chat.id, ["assistant", "Assistant"], "Alice")).status).toBe(200);
		expect((await merge(database, chat.id, ["Alice"], "Narrator")).status).toBe(200);
		expect((await merge(database, chat.id, ["Narrator"], "assistant")).status).toBe(200);
		expect(shown(readConversationMemories(database, chat.id))).toEqual([[["assistant", "Bob"]]]);
	});

	test("advances the label revision only on merges and the allowance revision only on allowance saves", async () => {
		const chat = createChat(database);
		addSource(database, chat.id, 1, ["assistant"]);
		const labelsBefore = readConversationMemories(database, chat.id).labelRevision;
		const settingsBefore = readMemoryChatSettings(database, chat.id).revision;
		setMemoryAllowance(database, chat.id, { expectedRevision: settingsBefore, allowance: 500 });
		const allowanceSaved = readMemoryChatSettings(database, chat.id).revision;
		expect(allowanceSaved).not.toBe(settingsBefore);
		expect(readConversationMemories(database, chat.id).labelRevision).toBe(labelsBefore);
		expect((await merge(database, chat.id, ["assistant"], "Alice", labelsBefore)).status).toBe(200);
		expect(readMemoryChatSettings(database, chat.id).revision).toBe(allowanceSaved);
		expect(readConversationMemories(database, chat.id).labelRevision).not.toBe(labelsBefore);
	});

	test("rejects stale or invalid merges without changing the labels", async () => {
		const chat = createChat(database);
		addSource(database, chat.id, 1, ["assistant", "Assistant"]);
		const stale = readConversationMemories(database, chat.id).labelRevision;
		expect((await merge(database, chat.id, ["assistant"], "Assistant")).status).toBe(200);
		const before = readConversationMemories(database, chat.id);
		expect((await merge(database, chat.id, ["Assistant"], "Alice", stale)).status).toBe(409);
		expect((await merge(database, chat.id, ["Assistant"], "   ")).status).toBe(422);
		expect((await merge(database, chat.id, ["Assistant"], "Assistant")).status).toBe(422);
		expect(readConversationMemories(database, chat.id)).toEqual(before);
	});
	test("a label revision read before Memory was removed cannot merge into the reinserted Box", async () => {
		const observed = openObservedDatabase();
		try {
			const chat = createChat(observed);
			addSource(observed, chat.id, 1, ["assistant"]);
			expect((await merge(observed, chat.id, ["assistant"], "Alice", readConversationMemories(observed, chat.id).labelRevision)).status).toBe(200);
			expect(readConversationMemories(observed, chat.id).labelMerges).toEqual([{ from: "assistant", to: "Alice" }]);
			const stale = readConversationMemories(observed, chat.id).labelRevision;

			setBoxState(observed, chat.id, "memory", "absent");
			insertBox(observed, chat.id, "memory");
			expect((await merge(observed, chat.id, ["Assistant"], "Bob", readConversationMemories(observed, chat.id).labelRevision)).status).toBe(200);
			const current = readConversationMemories(observed, chat.id).labelMerges;
			expect(current).toEqual([{ from: "Assistant", to: "Bob" }]);

			expect((await merge(observed, chat.id, ["Helper"], "Carol", stale)).status).toBe(409);
			expect(readConversationMemories(observed, chat.id).labelMerges).toEqual(current);
		} finally { observed.close(); }
	});
});
