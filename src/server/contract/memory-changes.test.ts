import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import { openInitializedDatabase } from "../database/database";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { memoryCollectionTable, messageTable, messageVariantTable } from "../database/schema";
import { conversationMemories, conversationMemoryChanges, type MemoryCandidateJudgment } from "../../shared/contract/memory";
import { correctMemorySource, readConversationMemories, resetAndReextractMemorySource, startMemoryWorker } from "../memory/collections";
import { mergeMemoryLabels } from "../memory/labels";
import { sha256 } from "../memory/hash";
import { configureMemoryEmbeddings, createChat, key } from "./prompt-preset-test-fixtures";
import { createMemoryRoutes } from "./memory";

const memory = (messageId: number, people: string[]): MemoryCandidateJudgment => ({ claim: "Alice promised Bob a key.", attribution: "Alice said it.", people, evidence: [{ messageId, excerpt: "I promised Bob a key." }], judgment: { support: "supported", attribution: "correct", usefulness: "retain", probabilities: {}, confidence: { support: 1, attribution: 1, usefulness: 1 } } });

const addSource = (database: Database, conversationId: number, position: number, people: string[], author = "Alice", selected = true, participantId?: number) => {
	const db = drizzle(database);
	const message = db.insert(messageTable).values({ conversation_id: conversationId, position, timestamp: "2026-09-23T00:00:00.000Z", author_name: author, author_participant_id: participantId ?? null }).returning().get();
	const variant = db.insert(messageVariantTable).values({ message_id: message.id, position: 0, timestamp: message.timestamp, content: "I promised Bob a key.", selected }).returning().get();
	db.insert(memoryCollectionTable).values({ conversation_id: conversationId, message_id: message.id, variant_id: variant.id, revision: 1, status: "complete", source_hash: sha256(variant.content), source_snapshot_json: JSON.stringify({ source: { messageId: message.id, variantId: variant.id, speaker: author, content: variant.content }, context: [] }), claims_json: JSON.stringify([memory(message.id, people)]), updated_at: message.timestamp }).run();
	return { messageId: message.id, variantId: variant.id };
};

const waitFor = async (check: () => boolean) => {
	const deadline = Date.now() + 4000;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	return check();
};

describe("Memory change feed public contract", () => {
	let database: Database;
	let app: ReturnType<typeof createMemoryRoutes>;
	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
		app = createMemoryRoutes(database);
	});
	afterEach(() => database.close());

	const read = async (conversationId: number) => {
		const response = await app.handle(new Request(`http://localhost/api/conversations/${conversationId}/memories`));
		if (response.status !== 200) throw new Error(`Memory read failed: ${await response.text()}`);
		return Value.Parse(conversationMemories, await response.json());
	};
	const changes = async (conversationId: number, since: string) => {
		const response = await app.handle(new Request(`http://localhost/api/conversations/${conversationId}/memories/changes?since=${encodeURIComponent(since)}`));
		if (response.status !== 200) throw new Error(`Memory change read failed: ${await response.text()}`);
		return Value.Parse(conversationMemoryChanges, await response.json());
	};
	const save = (conversationId: number, participantId: number, identity: { kind: "excluded" }) =>
		app.handle(new Request(`http://localhost/api/conversations/${conversationId}/memories/identity`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ participantId, identity, expectedRevision: readConversationMemories(database, conversationId).labelRevision }) }));

	test("returns the Conversation revision and a cursor, and only collections changed after it", async () => {
		const chat = createChat(database);
		const first = addSource(database, chat.id, 1, ["assistant"]);
		const second = addSource(database, chat.id, 2, ["Maren"]);
		await Bun.sleep(2);
		const full = await read(chat.id);
		expect(full.cursor).toEqual(expect.any(String));
		expect(full.revision).toBe(0);
		expect(full.sources.map(({ variantId }) => variantId).sort()).toEqual([first.variantId, second.variantId].sort());

		const quiet = await changes(chat.id, full.cursor);
		expect(quiet).toMatchObject({ revision: 0, labelRevision: 0, sources: [] });

		const current = readConversationMemories(database, chat.id).sources.find(({ variantId }) => variantId === first.variantId)!;
		const corrected = correctMemorySource(database, chat.id, { messageId: first.messageId, variantId: first.variantId, expectedRevision: current.revision, index: 0, operation: "edit", claim: "Bob returned the key.", attribution: "Alice said it.", people: ["Alice"] });
		await Bun.sleep(2);
		const delta = await changes(chat.id, full.cursor);
		expect(delta.cursor > full.cursor).toBe(true);
		expect(delta.sources).toEqual([expect.objectContaining({ variantId: first.variantId, ownership: "writer", revision: corrected.revision, claims: [expect.objectContaining({ claim: "Bob returned the key.", people: ["Alice"] })] })]);
		expect((await changes(chat.id, delta.cursor)).sources).toEqual([]);
	});

	test("feeds a queued source while its extraction runs and again when it completes", async () => {
		const chat = createChat(database);
		const source = addSource(database, chat.id, 1, ["assistant"]);
		const before = (await read(chat.id)).cursor;
		expect(resetAndReextractMemorySource(database, chat.id, source.messageId, source.variantId, 1).status).toBe("pending");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const stop = startMemoryWorker(database, { concurrency: 1, process: async (item) => { started.resolve(); await release.promise; return [memory(item.messageId, ["Alice"])]; } });
		try {
			await started.promise;
			const running = await changes(chat.id, before);
			expect(running.sources).toEqual([expect.objectContaining({ variantId: source.variantId, status: "running" })]);
			const registered = await changes(chat.id, running.cursor);
			expect(registered.sources).toEqual([expect.objectContaining({ variantId: source.variantId, status: "running" })]);
			release.resolve();
			await stop();
			const complete = await changes(chat.id, running.cursor);
			expect(complete.sources).toEqual([expect.objectContaining({ variantId: source.variantId, status: "complete", claims: [expect.objectContaining({ claim: "Alice promised Bob a key." })] })]);
		} finally { release.resolve(); await stop(); }
	});

	test("feeds a failed extraction after the cursor", async () => {
		const chat = createChat(database);
		const source = addSource(database, chat.id, 1, ["assistant"]);
		const before = (await read(chat.id)).cursor;
		resetAndReextractMemorySource(database, chat.id, source.messageId, source.variantId, 1);
		const stop = startMemoryWorker(database, { concurrency: 1, process: async () => { throw new Error("Extraction exploded."); } });
		try {
			expect(await waitFor(() => readConversationMemories(database, chat.id).sources[0]?.status === "failed")).toBe(true);
			await stop();
			const delta = await changes(chat.id, before);
			expect(delta.sources).toEqual([expect.objectContaining({ variantId: source.variantId, status: "failed", error: "Extraction exploded." })]);
		} finally { await stop(); }
	});

	test("feeds a completed index after the cursor", async () => {
		const chat = createChat(database);
		configureMemoryEmbeddings(database, "http://embedding.test/v1/embeddings", "memory-v1");
		const source = addSource(database, chat.id, 1, ["Maren"]);
		const full = await read(chat.id);
		expect(full.sources[0]?.indexing).toMatchObject({ status: "pending", pendingCount: 1 });
		const stop = startMemoryWorker(database, { concurrency: 1, process: async () => [], embed: async (texts) => texts.map(() => [1, 0]) });
		try {
			expect(await waitFor(() => readConversationMemories(database, chat.id).sources[0]?.indexing.status === "ready")).toBe(true);
			await stop();
			const delta = await changes(chat.id, full.cursor);
			expect(delta.sources).toEqual([expect.objectContaining({ variantId: source.variantId, indexing: { status: "ready", pendingCount: 0, error: null } })]);
		} finally { await stop(); }
	});

	test("feeds every collection a label merge rewrites", async () => {
		const chat = createChat(database);
		const selected = addSource(database, chat.id, 1, ["assistant", "Assistant"]);
		const alternate = addSource(database, chat.id, 2, ["assistant"], "Alice", false);
		const full = await read(chat.id);
		mergeMemoryLabels(database, chat.id, { expectedRevision: 0, labels: ["assistant", "Assistant"], destination: "Alice" });
		const delta = await changes(chat.id, full.cursor);
		expect(delta.labelRevision).toBe(1);
		expect(delta.sources.map(({ variantId, claims }) => [variantId, claims[0]!.people])).toEqual([[selected.variantId, ["Alice"]], [alternate.variantId, ["Alice"]]]);
	});

	test("never surfaces a Not-in-the-story author's collection", async () => {
		const chat = createChat(database);
		const writer = chat.cast[0]!;
		const maren = chat.cast[1]!;
		const full = await read(chat.id);
		expect((await save(chat.id, writer.id, { kind: "excluded" })).status).toBe(200);
		const excluded = addSource(database, chat.id, 1, ["Writer"], "Writer", true, writer.id);
		const visible = addSource(database, chat.id, 2, ["Maren"], "Maren", true, maren.id);
		database.run("UPDATE memory_collection SET updated_at = ?", [new Date().toISOString()]);
		const delta = await changes(chat.id, full.cursor);
		expect(excluded.variantId).not.toBe(visible.variantId);
		expect(delta.sources.map(({ variantId }) => variantId)).toEqual([visible.variantId]);
	});
});
