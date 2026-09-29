import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConversationModule } from "../conversation";
import { startMemoryWorker } from "../memory";
import { createConversationRoutes } from "./conversation";
import { createMemoryRoutes } from "./memory";
import { createChat, readOperation, readPreset, toggleBlock } from "./prompt-preset-test-fixtures";
import { Value } from "@sinclair/typebox/value";
import { conversationMemories, memoryCorrectionApplied, memoryCatchup, memoryCatchupRead } from "../../shared/contract/memory";

const waitFor = async (check: () => boolean | Promise<boolean>) => {
	const deadline = Date.now() + 4000;
	while (!await check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	return await check();
};
const insertMessage = (database: Database, conversationId: number, position: number, content: string) => {
	const row = database.query<{ id: number }, [number, number]>("INSERT INTO messages (conversation_id, position, timestamp) VALUES (?, ?, '2026-09-23T00:00:00.000Z') RETURNING id").get(conversationId, position);
	if (!row) throw new Error("Memory fixture Message insert failed.");
	const variant = database.query<{ id: number }, [number, string]>("INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 0, ?, '2026-09-23T00:00:00.000Z', 1) RETURNING id").get(row.id, content);
	if (!variant) throw new Error("Memory fixture Variant insert failed.");
	return { messageId: row.id, variantId: variant.id };
};
const enableMemory = async (database: Database, conversationId: number) => {
	const routes = createConversationRoutes(database);
	const preset = await readPreset(routes, conversationId);
	const block = preset.slots.find((slot) => slot.reference === "memory");
	if (!block) throw new Error("The Default recipe has no Memory block.");
	if (!block.enabled) await readOperation(toggleBlock(database, preset.id, block.id, true));
};
const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, { headers: { "content-type": "application/json", ...init?.headers }, ...init });
const supportedMemory = (messageId: number, content: string) => [{ claim: "The event occurred.", attribution: "Narrated event", people: [], evidence: [{ messageId, excerpt: content }], judgment: { support: "supported" as const, attribution: "correct" as const, usefulness: "retain" as const, probabilities: { "support:supported": 1, "usefulness:retain": 1 }, confidence: { support: 1, attribution: 1, usefulness: 1 } } }];
const createWriterCollection = async (database: Database, memories: ReturnType<typeof createMemoryRoutes>, conversationId: number, source: { messageId: number; variantId: number }) => {
	const queued = await memories.handle(request(`/api/conversations/${conversationId}/memories/reextract`, { method: "POST", body: JSON.stringify({ messageId: source.messageId, variantId: source.variantId, expectedRevision: 0 }) }));
	expect(queued.status).toBe(200);
	const stop = startMemoryWorker(database, { process: async (message) => supportedMemory(message.messageId, message.content) });
	try {
		expect(await waitFor(() => database.query<{ status: string }, [number]>("SELECT status FROM memory_collection WHERE variant_id = ?").get(source.variantId)?.status === "complete")).toBe(true);
	} finally { await stop(); }
	const corrected = await memories.handle(request(`/api/conversations/${conversationId}/memories/correct`, { method: "POST", body: JSON.stringify({ messageId: source.messageId, variantId: source.variantId, expectedRevision: 1, index: 0, operation: "edit", claim: "Writer maintained this event.", attribution: "Writer correction", people: [] }) }));
	expect(corrected.status).toBe(200);
	return Value.Parse(memoryCorrectionApplied, await corrected.json()).collection;
};

describe("Memory source lifecycle public operations", () => {
	let database: Database;
	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("returns an explicit empty catch-up envelope before the first run", async () => {
		const conversation = createChat(database);
		const response = await createMemoryRoutes(database).handle(request(`/api/conversations/${conversation.id}/memories/catchup`));
		expect(response.status).toBe(200);
		expect(Value.Parse(memoryCatchupRead, await response.json())).toEqual({ run: null });
	});

	test("queues retained content when one Generation is stopped", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		const module = createConversationModule(database);
		const snapshot = module.getSnapshot(conversation.id);
		if (!snapshot || snapshot.control.humanParticipantId === null || snapshot.control.modelParticipantId === null) throw new Error("Memory fixture has no active Chat controls.");
		const accepted = module.acceptTailGeneration({
			conversationId: conversation.id,
			expectedRevision: snapshot.revision,
			timestamp: "2026-09-23T00:01:00.000Z",
			humanContent: "Where is the key?",
			humanParticipantId: snapshot.control.humanParticipantId,
			modelParticipantId: snapshot.control.modelParticipantId,
			capturedHumanName: "Writer",
			capturedModelName: "Maren",
			promptPlan: { blocks: [], warnings: [] },
			promptContext: [],
			generationSettings: {},
			connection: null,
		});
		module.checkpointGeneration({ conversationId: conversation.id, generationId: accepted.generationId, content: "Maren hides the key." });
		module.stopGeneration({ conversationId: conversation.id, generationId: accepted.generationId });
		const generated = module.getSnapshot(conversation.id)?.messages.at(-1);
		const selectedVariant = generated?.variants.find((variant) => variant.selected);
		if (!selectedVariant) throw new Error("Stopped Generation did not retain a selected Variant.");
		const response = await createMemoryRoutes(database).handle(request(`/api/conversations/${conversation.id}/memories`));
		const { sources } = Value.Parse(conversationMemories, await response.json());
		expect(sources.find((source) => source.variantId === selectedVariant.id)).toMatchObject({ status: "pending", selected: true });
	});

	test("queues a selected Human source and selected Swipe while retaining the prior collection", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		const snapshot = createConversationModule(database).getSnapshot(conversation.id);
		if (!snapshot) throw new Error("Memory fixture Chat was not created.");
		const humanId = snapshot.control.humanParticipantId;
		if (humanId === null) throw new Error("Memory fixture has no Human Control.");
		const routes = createConversationRoutes(database);
		const created = await routes.handle(request(`/api/conversations/${conversation.id}/commands`, { method: "POST", body: JSON.stringify({ expectedRevision: snapshot.revision, action: { type: "create-message", timestamp: "2026-09-23T00:00:00.000Z", variantContents: ["The writer sets out."], authorParticipantId: humanId } }) }));
		expect(created.status).toBe(200);
		const first = database.query<{ messageId: number; variantId: number; status: string }, [number]>("SELECT message_id AS messageId, variant_id AS variantId, status FROM memory_collection WHERE conversation_id = ?").get(conversation.id);
		expect(first?.status).toBe("pending");
		const stop = startMemoryWorker(database, { process: async () => [] });
		try {
			expect(await waitFor(() => database.query<{ status: string }, [number]>("SELECT status FROM memory_collection WHERE variant_id = ?").get(first!.variantId)?.status === "complete")).toBe(true);
			await stop();
			const swiped = await routes.handle(request(`/api/conversations/${conversation.id}/commands`, { method: "POST", body: JSON.stringify({ expectedRevision: snapshot.revision + 1, action: { type: "create-variant", messageId: first!.messageId, content: "The writer returns with the key." } }) }));
			expect(swiped.status).toBe(200);
			const selected = database.query<{ id: number; selected: number }, [number]>("SELECT id, selected FROM message_variant WHERE message_id = ? ORDER BY id DESC LIMIT 1").get(first!.messageId);
			expect(selected).toMatchObject({ selected: 1 });
			expect(database.query<{ status: string }, [number]>("SELECT status FROM memory_collection WHERE variant_id = ?").get(selected!.id)?.status).toBe("pending");
			expect(database.query<{ status: string }, [number]>("SELECT status FROM memory_collection WHERE variant_id = ?").get(first!.variantId)?.status).toBe("complete");
			const { sources } = Value.Parse(conversationMemories, await (await createMemoryRoutes(database).handle(request(`/api/conversations/${conversation.id}/memories`))).json());
			expect(sources.find((source) => source.variantId === first!.variantId)).toMatchObject({ selected: false, status: "complete" });
			expect(sources.find((source) => source.variantId === selected!.id)).toMatchObject({ selected: true, status: "pending" });
		} finally { await stop(); }
	});

	test("captures catch-up context from one ordered path and caps it at four selected Variants", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		const messages = Array.from({ length: 6 }, (_, index) => insertMessage(database, conversation.id, index + 1, `Message ${index + 1}.`));
		const started = await createMemoryRoutes(database).handle(request(`/api/conversations/${conversation.id}/memories/catchup`, { method: "POST", body: "{}" }));
		const run = Value.Parse(memoryCatchup, await started.json());
		const saved = database.query<{ source_snapshot_json: string }, [number, number]>("SELECT source_snapshot_json FROM memory_collection WHERE catchup_run_id = ? AND variant_id = ?").get(run.id, messages[5]!.variantId);
		expect(saved).not.toBeUndefined();
		expect(JSON.parse(saved!.source_snapshot_json)).toEqual({
			source: { messageId: messages[5]!.messageId, variantId: messages[5]!.variantId, content: "Message 6." },
			context: messages.slice(1, 5).map((message, index) => ({ messageId: message.messageId, variantId: message.variantId, content: `Message ${index + 2}.` })),
		});
	});

	test("correction claims source ownership and catch-up skips current, writer-cleared, and empty sources", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		const current = insertMessage(database, conversation.id, 1, "A completed source.");
		const cleared = insertMessage(database, conversation.id, 2, "A writer-cleared source.");
		const historical = insertMessage(database, conversation.id, 3, "A source for catch-up.");
		const empty = insertMessage(database, conversation.id, 4, "   ");
		const memories = createMemoryRoutes(database);
		for (const source of [current, cleared]) {
			const queued = await memories.handle(request(`/api/conversations/${conversation.id}/memories/reextract`, { method: "POST", body: JSON.stringify({ messageId: source.messageId, variantId: source.variantId, expectedRevision: 0 }) }));
			expect(queued.status).toBe(200);
		}
		const stop = startMemoryWorker(database, { concurrency: 1, process: async (source) => source.messageId === cleared.messageId ? supportedMemory(source.messageId, source.content) : [] });
		try {
			expect(await waitFor(() => database.query<{ status: string }, [number]>("SELECT status FROM memory_collection WHERE variant_id = ?").get(cleared.variantId)?.status === "complete" && database.query<{ status: string }, [number]>("SELECT status FROM memory_collection WHERE variant_id = ?").get(current.variantId)?.status === "complete")).toBe(true);
			const edited = await memories.handle(request(`/api/conversations/${conversation.id}/memories/correct`, { method: "POST", body: JSON.stringify({ messageId: cleared.messageId, variantId: cleared.variantId, expectedRevision: 1, index: 0, operation: "edit", claim: "Corrected event.", attribution: "Writer correction", people: [] }) }));
			expect(edited.status).toBe(200);
			expect(await edited.json()).toMatchObject({ outcome: "applied", collection: { ownership: "writer", revision: 2, claims: [{ claim: "Corrected event.", writerMaintained: true, evidence: [{ excerpt: "A writer-cleared source." }] }] } });
			const conflict = await memories.handle(request(`/api/conversations/${conversation.id}/memories/correct`, { method: "POST", body: JSON.stringify({ messageId: cleared.messageId, variantId: cleared.variantId, expectedRevision: 1, index: 0, operation: "remove" }) }));
			expect(conflict.status).toBe(409);
			expect(await conflict.json()).toMatchObject({ collection: { revision: 2, ownership: "writer", claims: [{ claim: "Corrected event." }] } });
			const removed = await memories.handle(request(`/api/conversations/${conversation.id}/memories/correct`, { method: "POST", body: JSON.stringify({ messageId: cleared.messageId, variantId: cleared.variantId, expectedRevision: 2, index: 0, operation: "remove" }) }));
			expect(removed.status).toBe(200);
			expect(await removed.json()).toMatchObject({ outcome: "applied", collection: { ownership: "writer", revision: 3, claims: [] } });
			const started = await memories.handle(request(`/api/conversations/${conversation.id}/memories/catchup`, { method: "POST", body: "{}" }));
			expect(started.status).toBe(200);
			const run = Value.Parse(memoryCatchup, await started.json());
			expect(run).toMatchObject({ pending: 1, state: "running" });
			expect(database.query<{ variant_id: number }, [number]>("SELECT variant_id FROM memory_collection WHERE catchup_run_id = ?").all(run.id)).toEqual([{ variant_id: historical.variantId }]);
			expect(database.query<{ count: number }, [number]>("SELECT count(*) AS count FROM memory_collection WHERE variant_id = ?").get(empty.variantId)).toMatchObject({ count: 0 });
			expect(await waitFor(async () => { const value = Value.Parse(memoryCatchupRead, await (await memories.handle(request(`/api/conversations/${conversation.id}/memories/catchup`))).json()); return value.run !== null && Value.Check(memoryCatchup, value.run) && value.run.state === "complete"; })).toBe(true);
			const reset = await memories.handle(request(`/api/conversations/${conversation.id}/memories/reextract`, { method: "POST", body: JSON.stringify({ messageId: cleared.messageId, variantId: cleared.variantId, expectedRevision: 3 }) }));
			expect(reset.status).toBe(200);
			expect(await reset.json()).toMatchObject({ collection: { ownership: "automatic", status: "pending", claims: [] } });
			expect(await waitFor(() => database.query<{ ownership: string; status: string }, [number]>("SELECT ownership, status FROM memory_collection WHERE variant_id = ?").get(cleared.variantId)?.status === "complete")).toBe(true);
		} finally { await stop(); }
	});

	test("does not reset the newly selected Swipe when a confirmed writer reset targets another Swipe", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		const source = insertMessage(database, conversation.id, 1, "The first Swipe is writer-maintained.");
		const memories = createMemoryRoutes(database);
		const writerCollection = await createWriterCollection(database, memories, conversation.id, source);
		const confirmed = Value.Parse(conversationMemories, await (await memories.handle(request(`/api/conversations/${conversation.id}/memories`))).json()).sources.find((item) => item.variantId === source.variantId);
		expect(confirmed).toMatchObject({ ownership: "writer", revision: writerCollection.revision, selected: true });

		const changed = await createConversationRoutes(database).handle(request(`/api/conversations/${conversation.id}/commands`, {
			method: "POST",
			body: JSON.stringify({ expectedRevision: 0, action: { type: "create-variant", messageId: source.messageId, content: "The newly selected Swipe." } }),
		}));
		expect(changed.status).toBe(200);
		const selected = database.query<{ id: number; selected: number }, [number]>("SELECT id, selected FROM message_variant WHERE message_id = ? ORDER BY id DESC LIMIT 1").get(source.messageId);
		if (!selected) throw new Error("The replacement Swipe was not stored.");
		expect(selected.selected).toBe(1);

		const reset = await memories.handle(request(`/api/conversations/${conversation.id}/memories/reextract`, {
			method: "POST",
			body: JSON.stringify({ messageId: source.messageId, variantId: source.variantId, expectedRevision: confirmed!.revision }),
		}));
		expect(reset.status).toBe(409);
		expect(await reset.json()).toMatchObject({ outcome: "conflict", collection: { messageId: source.messageId, variantId: source.variantId, revision: confirmed!.revision, selected: false, ownership: "writer" } });
		expect(database.query<{ revision: number; ownership: string }, [number]>("SELECT revision, ownership FROM memory_collection WHERE variant_id = ?").get(selected.id)).toMatchObject({ revision: 1, ownership: "automatic" });
	});

	test("rejects a confirmed reset after the writer collection revision changes", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		const source = insertMessage(database, conversation.id, 1, "A writer-maintained source.");
		const memories = createMemoryRoutes(database);
		const writerCollection = await createWriterCollection(database, memories, conversation.id, source);
		const confirmedRevision = writerCollection.revision;
		const updated = await memories.handle(request(`/api/conversations/${conversation.id}/memories/correct`, {
			method: "POST",
			body: JSON.stringify({ messageId: source.messageId, variantId: source.variantId, expectedRevision: confirmedRevision, index: 0, operation: "edit", claim: "A newer writer correction.", attribution: "Writer correction", people: [] }),
		}));
		expect(updated.status).toBe(200);

		const reset = await memories.handle(request(`/api/conversations/${conversation.id}/memories/reextract`, {
			method: "POST",
			body: JSON.stringify({ messageId: source.messageId, variantId: source.variantId, expectedRevision: confirmedRevision }),
		}));
		expect(reset.status).toBe(409);
		expect(await reset.json()).toMatchObject({ outcome: "conflict", collection: { variantId: source.variantId, revision: confirmedRevision + 1, ownership: "writer", claims: [{ claim: "A newer writer correction." }] } });
	});

	test("catch-up cancellation invalidates its late result and leaves new live work intact", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		const source = insertMessage(database, conversation.id, 1, "Catch-up source.");
		const memories = createMemoryRoutes(database);
		const started = await memories.handle(request(`/api/conversations/${conversation.id}/memories/catchup`, { method: "POST", body: "{}" }));
		const run = Value.Parse(memoryCatchup, await started.json());
		let release = () => {};
		let running = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const began = new Promise<void>((resolve) => { running = resolve; });
		const stop = startMemoryWorker(database, { concurrency: 1, process: async (item) => { if (item.messageId === source.messageId) { running(); await gate; return supportedMemory(item.messageId, item.content); } return []; } });
		try {
			await began;
			const routes = createConversationRoutes(database);
			const swipe = await routes.handle(request(`/api/conversations/${conversation.id}/commands`, { method: "POST", body: JSON.stringify({ expectedRevision: 0, action: { type: "create-variant", messageId: source.messageId, content: "New live source." } }) }));
			expect(swipe.status).toBe(200);
			const live = database.query<{ id: number; content: string }, [number]>("SELECT id, content FROM message_variant WHERE message_id = ? ORDER BY id DESC LIMIT 1").get(source.messageId);
			const cancelled = await memories.handle(request(`/api/conversations/${conversation.id}/memories/catchup/${run.id}`, { method: "DELETE" }));
			expect(cancelled.status).toBe(200);
			release();
			expect(await waitFor(() => database.query<{ status: string }, [number]>("SELECT status FROM memory_collection WHERE variant_id = ?").get(live!.id)?.status === "complete")).toBe(true);
			expect(database.query<{ status: string; claims_json: string }, [number]>("SELECT status, claims_json FROM memory_collection WHERE variant_id = ?").get(source.variantId)).toMatchObject({ status: "failed", claims_json: "[]" });
			expect(await (await memories.handle(request(`/api/conversations/${conversation.id}/memories/catchup`))).json()).toMatchObject({ run: { id: run.id, state: "cancelled" } });
		} finally { release(); await stop(); }
	});

	test("cancelling an older catch-up keeps sources a newer catch-up also requested", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		const source = insertMessage(database, conversation.id, 1, "Shared catch-up source.");
		const memories = createMemoryRoutes(database);
		const start = async () => Value.Parse(memoryCatchup, await (await memories.handle(request(`/api/conversations/${conversation.id}/memories/catchup`, { method: "POST", body: "{}" }))).json());
		const older = await start();
		const newer = await start();
		expect((await memories.handle(request(`/api/conversations/${conversation.id}/memories/catchup/${older.id}`, { method: "DELETE" }))).status).toBe(200);
		const stop = startMemoryWorker(database, { process: async (item) => supportedMemory(item.messageId, item.content) });
		try {
			expect(await waitFor(() => database.query<{ status: string }, [number]>("SELECT status FROM memory_collection WHERE variant_id = ?").get(source.variantId)?.status === "complete")).toBe(true);
			expect(await (await memories.handle(request(`/api/conversations/${conversation.id}/memories/catchup`))).json()).toMatchObject({ run: { id: newer.id, state: "complete", complete: 1 } });
		} finally { await stop(); }
	});

	test("a completed catch-up remains complete when cancellation arrives late", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		const source = insertMessage(database, conversation.id, 1, "Completed catch-up source.");
		const memories = createMemoryRoutes(database);
		const run = Value.Parse(memoryCatchup, await (await memories.handle(request(`/api/conversations/${conversation.id}/memories/catchup`, { method: "POST", body: "{}" }))).json());
		const stop = startMemoryWorker(database, { process: async (item) => supportedMemory(item.messageId, item.content) });
		try {
			expect(await waitFor(() => database.query<{ status: string }, [number]>("SELECT status FROM memory_collection WHERE variant_id = ?").get(source.variantId)?.status === "complete")).toBe(true);
			expect((await memories.handle(request(`/api/conversations/${conversation.id}/memories/catchup/${run.id}`, { method: "DELETE" }))).status).toBe(422);
			expect(await (await memories.handle(request(`/api/conversations/${conversation.id}/memories/catchup`))).json()).toMatchObject({ run: { id: run.id, state: "complete", complete: 1 } });
		} finally { await stop(); }
	});

	test("catch-up cancellation aborts both extraction jobs and releases worker capacity", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		const sources = [insertMessage(database, conversation.id, 1, "First catch-up source."), insertMessage(database, conversation.id, 2, "Second catch-up source.")];
		const memories = createMemoryRoutes(database);
		const started = await memories.handle(request(`/api/conversations/${conversation.id}/memories/catchup`, { method: "POST", body: "{}" }));
		const run = Value.Parse(memoryCatchup, await started.json());
		const signals: AbortSignal[] = [];
		let attempts = 0;
		const stop = startMemoryWorker(database, { concurrency: 2, process: async (_source, _context, signal) => {
			signals.push(signal);
			attempts += 1;
			if (attempts > 2) return [];
			return new Promise((_, reject) => {
				const abort = () => reject(new DOMException("The extraction was cancelled.", "AbortError"));
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
			});
		} });
		try {
			expect(await waitFor(() => attempts === 2)).toBe(true);
			expect((await memories.handle(request(`/api/conversations/${conversation.id}/memories/catchup/${run.id}`, { method: "DELETE" }))).status).toBe(200);
			expect(signals.every((signal) => signal.aborted)).toBe(true);
			for (const source of sources) expect((await memories.handle(request(`/api/conversations/${conversation.id}/memories/reextract`, { method: "POST", body: JSON.stringify({ messageId: source.messageId, variantId: source.variantId, expectedRevision: 1 }) }))).status).toBe(200);
			expect(await waitFor(() => attempts === 4 && sources.every(({ variantId }) => database.query<{ status: string }, [number]>("SELECT status FROM memory_collection WHERE variant_id=?").get(variantId)?.status === "complete"))).toBe(true);
		} finally { await stop(); }
	});
});
