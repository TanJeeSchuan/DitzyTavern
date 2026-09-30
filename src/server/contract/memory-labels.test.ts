import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openInitializedDatabase } from "../database/database";
import { memoryCollectionTable, messageTable, messageVariantTable } from "../database/schema";
import { createChat } from "./prompt-preset-test-fixtures";
import { createMemoryRoutes } from "./memory";
import { correctMemorySource, readConversationMemories, readMemoryAllowance, setMemoryAllowance, resetAndReextractMemorySource, startMemoryCatchup, startMemoryWorker, StaleMemoryCollectionError } from "../memory/collections";
import { sha256 } from "../memory/hash";
import { Value } from "@sinclair/typebox/value";
import { memoryLabelsMerged, memoryWorkSnapshot, type MemoryCandidateJudgment } from "../../shared/contract/memory";

const memory = (messageId: number, people: string[]): MemoryCandidateJudgment => ({ claim: "Alice promised Bob a key.", attribution: "Alice said it.", people, evidence: [{ messageId, excerpt: "I promised Bob a key." }], judgment: { support: "supported", attribution: "correct", usefulness: "retain", probabilities: {}, confidence: { support: 1, attribution: 1, usefulness: 1 } } });

const addSource = (database: Database, conversationId: number, position: number, people: string[], selected = true) => {
	const db = drizzle(database);
	const message = db.insert(messageTable).values({ conversation_id: conversationId, position, timestamp: "2026-09-29T00:00:00Z", author_name: "Alice" }).returning().get();
	const variant = db.insert(messageVariantTable).values({ message_id: message.id, position: 0, timestamp: message.timestamp, content: "I promised Bob a key.", selected }).returning().get();
	db.insert(memoryCollectionTable).values({ conversation_id: conversationId, message_id: message.id, variant_id: variant.id, revision: 1, status: "complete", source_hash: sha256(variant.content), source_snapshot_json: JSON.stringify({ source: { messageId: message.id, variantId: variant.id, speaker: "Alice", content: variant.content }, context: [] }), claims_json: JSON.stringify([memory(message.id, people)]), updated_at: message.timestamp }).run();
	return { messageId: message.id, variantId: variant.id };
};

const merge = (database: Database, conversationId: number, labels: string[], destination: string, expectedRevision = readConversationMemories(database, conversationId).labelRevision) =>
	createMemoryRoutes(database).handle(new Request(`http://localhost/api/conversations/${conversationId}/memories/merge-labels`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ labels, destination, expectedRevision }) }));

describe("Memory label merging", () => {
	let database: Database;
	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("merges selected and alternate memories atomically without rewriting facts, evidence, or ownership", async () => {
		const chat = createChat(database);
		const selected = addSource(database, chat.id, 1, ["assistant", "Assistant", "Bob"]);
		addSource(database, chat.id, 2, ["Assistant"], false);
		const other = createChat(database);
		addSource(database, other.id, 1, ["assistant"]);
		const before = readConversationMemories(database, chat.id);
		const response = await merge(database, chat.id, ["assistant", "Assistant"], " Alice ");
		expect(response.status).toBe(200);
		const { memories } = Value.Parse(memoryLabelsMerged, await response.json());
		expect(memories.sources.map((source) => source.claims[0]!.people)).toEqual([["Alice", "Bob"], ["Alice"]]);
		for (const [index, source] of memories.sources.entries()) {
			expect(source.ownership).toBe("automatic");
			expect(source.revision).toBe(2);
			expect(source.claims[0]).toEqual({ ...before.sources[index]!.claims[0]!, people: source.claims[0]!.people });
		}
		expect(readConversationMemories(database, other.id).sources[0]!.claims[0]!.people).toEqual(["assistant"]);
		expect(() => correctMemorySource(database, chat.id, { ...selected, expectedRevision: 1, index: 0, operation: "remove" })).toThrow(StaleMemoryCollectionError);
	});

	test("flattens repeated merges, supports renaming back, and applies mappings to manual corrections", async () => {
		const chat = createChat(database);
		const source = addSource(database, chat.id, 1, ["assistant", "Assistant"]);
		expect((await merge(database, chat.id, ["assistant", "Assistant"], "Alice")).status).toBe(200);
		expect((await merge(database, chat.id, ["Alice"], "Narrator")).status).toBe(200);
		expect((await merge(database, chat.id, ["Narrator"], "assistant")).status).toBe(200);
		const current = readConversationMemories(database, chat.id).sources[0]!;
		const corrected = correctMemorySource(database, chat.id, { ...source, expectedRevision: current.revision, index: 0, operation: "edit", claim: "Bob has the key.", attribution: "Alice said it.", people: ["Alice", "Narrator", "Assistant", "Bob"] });
		expect(corrected.claims[0]!.people).toEqual(["assistant", "Bob"]);
	});

	test("advances the label revision only on merges and the allowance revision only on allowance saves", async () => {
		const chat = createChat(database);
		addSource(database, chat.id, 1, ["assistant"]);
		setMemoryAllowance(database, chat.id, 0, 500);
		expect(readConversationMemories(database, chat.id).labelRevision).toBe(0);
		expect((await merge(database, chat.id, ["assistant"], "Alice", 0)).status).toBe(200);
		expect(readMemoryAllowance(database, chat.id).revision).toBe(1);
		expect(readConversationMemories(database, chat.id).labelRevision).toBe(1);
	});

	test("reads an invalid persisted merge mapping as empty instead of failing the panel", () => {
		const chat = createChat(database);
		readMemoryAllowance(database, chat.id);
		for (const invalid of ["{}", "null", "[{\"from\":1}]", "[{"]) {
			database.run("UPDATE conversation_memory_settings SET label_merges = ? WHERE conversation_id = ?", [invalid, chat.id]);
			expect(readConversationMemories(database, chat.id).labelRevision).toBe(0);
		}
	});

	test("rejects stale or invalid merges without changing any collections", async () => {
		const chat = createChat(database);
		addSource(database, chat.id, 1, ["assistant", "Assistant"]);
		expect((await merge(database, chat.id, ["assistant"], "Assistant")).status).toBe(200);
		const before = readConversationMemories(database, chat.id);
		expect((await merge(database, chat.id, ["Assistant"], "Alice", 0)).status).toBe(409);
		expect((await merge(database, chat.id, ["Assistant"], "   ")).status).toBe(422);
		expect((await merge(database, chat.id, ["Assistant"], "Assistant")).status).toBe(422);
		expect(readConversationMemories(database, chat.id)).toEqual(before);
	});

	test("normalizes an extraction already running at merge time and preserves captured speakers", async () => {
		const chat = createChat(database);
		const prior = addSource(database, chat.id, 1, ["assistant"]);
		const source = addSource(database, chat.id, 2, ["Assistant"]);
		resetAndReextractMemorySource(database, chat.id, source.messageId, source.variantId, 1);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<void>();
		const stop = startMemoryWorker(database, { concurrency: 1, process: async (captured, context) => {
			expect(captured.speaker).toBe("Alice");
			expect(context).toMatchObject([{ messageId: prior.messageId, speaker: "Alice" }]);
			started.resolve();
			await release.promise;
			finished.resolve();
			return [memory(captured.messageId, ["assistant", "Assistant", "Alice"])];
		} });
		try {
			await started.promise;
			expect((await merge(database, chat.id, ["assistant", "Assistant"], "Alice")).status).toBe(200);
			release.resolve();
			await finished.promise;
			await stop();
			const saved = readConversationMemories(database, chat.id).sources.find((item) => item.variantId === source.variantId)!;
			expect(saved.status).toBe("complete");
			expect(saved.claims[0]!.people).toEqual(["Alice"]);
			resetAndReextractMemorySource(database, chat.id, source.messageId, source.variantId, saved.revision);
			const nextStop = startMemoryWorker(database, { process: async (captured) => [memory(captured.messageId, ["Assistant"])] });
			try {
				const deadline = Date.now() + 2000;
				while (readConversationMemories(database, chat.id).sources.find((item) => item.variantId === source.variantId)?.status !== "complete" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
				expect(readConversationMemories(database, chat.id).sources.find((item) => item.variantId === source.variantId)?.claims[0]?.people).toEqual(["Alice"]);
			} finally { await nextStop(); }
		} finally { release.resolve(); await stop(); }
	});

	test("catch-up captures historical author names for the source and reference messages", () => {
		const chat = createChat(database);
		const prior = addSource(database, chat.id, 1, []);
		const source = addSource(database, chat.id, 2, []);
		database.run("DELETE FROM memory_collection WHERE conversation_id = ?", [chat.id]);
		startMemoryCatchup(database, chat.id);
		const row = database.query<{ source_snapshot_json: string }, [number]>("SELECT source_snapshot_json FROM memory_collection WHERE variant_id = ?").get(source.variantId)!;
		const snapshot = Value.Parse(memoryWorkSnapshot, JSON.parse(row.source_snapshot_json));
		expect(snapshot.source.speaker).toBe("Alice");
		expect(snapshot.context).toMatchObject([{ messageId: prior.messageId, speaker: "Alice" }]);
	});
});
