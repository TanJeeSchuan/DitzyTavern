import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import { openInitializedDatabase } from "../database/database";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { embedMemoryJob } from "../memory/indexing";
import { captureMemoryRecallSnapshot } from "../memory/recall";
import { startMemoryWorker } from "../memory";
import type { MemoryCandidateJudgment } from "../memory/extraction";
import type { ModelFetch } from "../model-client";
import { renderMemoryClaim } from "../../shared/memory-text";
import { conversationMemories, memoryCorrectionApplied } from "../../shared/contract/memory";
import { embeddingSettingsApplied } from "../../shared/contract/embedding-settings";
import { createConversationRoutes } from "./conversation";
import { createEmbeddingSettingsRoutes } from "./embedding-settings";
import { createMemoryRoutes } from "./memory";
import { createChat, key, readOperation, readPreset, toggleBlock } from "./prompt-preset-test-fixtures";

const waitFor = async (check: () => boolean | Promise<boolean>) => {
	const deadline = Date.now() + 4_000;
	while (!await check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	return await check();
};

const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, {
	headers: { "content-type": "application/json", ...init?.headers },
	...init,
});

const insertSource = (database: Database, conversationId: number, position: number, content: string) => {
	const message = database.query<{ id: number }, [number, number]>("INSERT INTO messages (conversation_id, position, timestamp) VALUES (?, ?, '2026-09-23T00:00:00.000Z') RETURNING id").get(conversationId, position);
	if (!message) throw new Error("Memory indexing fixture Message insert failed.");
	const variant = database.query<{ id: number }, [number, string]>("INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 0, ?, '2026-09-23T00:00:00.000Z', 1) RETURNING id").get(message.id, content);
	if (!variant) throw new Error("Memory indexing fixture Variant insert failed.");
	return { messageId: message.id, variantId: variant.id };
};

const candidate = (messageId: number, excerpt: string, claim = "Maren carries Writer's key.", attribution = "Narrated event"): MemoryCandidateJudgment => ({
	claim,
	attribution,
	people: ["Maren", "Writer"],
	evidence: [{ messageId, excerpt }],
	judgment: {
		support: "supported",
		usefulness: "retain",
		probabilities: { "support:supported": 1, "usefulness:retain": 1 },
	},
});

const configureEmbeddings = async (app: ReturnType<typeof createEmbeddingSettingsRoutes>, endpoint: string, model: string, expectedRevision = 0) => {
	const response = await app.handle(request("/api/embedding-settings/commands", {
		method: "POST",
		body: JSON.stringify({ type: "apply", expectedRevision, endpoint, model, threshold: 0.7, deadlineMs: 1_000, credential: "embedding-secret" }),
	}));
	if (response.status !== 200) throw new Error(`Embedding Settings fixture failed: ${await response.text()}`);
	return Value.Parse(embeddingSettingsApplied, await response.json()).settings;
};

const enableMemory = async (database: Database, conversationId: number) => {
	const app = createConversationRoutes(database);
	const preset = await readPreset(app, conversationId);
	const block = preset.slots.find((slot) => slot.reference === "memory");
	if (!block) throw new Error("The Default recipe has no Memory block.");
	if (!block.enabled) await readOperation(toggleBlock(database, preset.id, block.id, true));
};

const queueSource = async (app: ReturnType<typeof createMemoryRoutes>, conversationId: number, messageId: number) => {
	const response = await app.handle(request(`/api/conversations/${conversationId}/memories/reextract`, {
		method: "POST",
		body: JSON.stringify({ messageId }),
	}));
	if (response.status !== 200) throw new Error(`Memory source fixture failed: ${await response.text()}`);
};

const readSources = async (app: ReturnType<typeof createMemoryRoutes>, conversationId: number) => {
	const response = await app.handle(request(`/api/conversations/${conversationId}/memories`));
	if (response.status !== 200) throw new Error(`Memory read fixture failed: ${await response.text()}`);
	return Value.Parse(conversationMemories, await response.json()).sources;
};

type EmbeddingRequest = { url: string; model: string; input: string[]; authorization: string | null };

const embeddingFetch = (requests: EmbeddingRequest[], wait?: (url: string, signal: AbortSignal | null) => Promise<void>): ModelFetch => async (input, init) => {
	// SAFETY: the application generated this request from its embedding settings and text batch; this fake reads those typed fields.
	const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
	const url = String(input);
	const headers = new Headers(init?.headers);
	requests.push({ url, model: body.model, input: body.input, authorization: headers.get("authorization") });
	await wait?.(url, init?.signal ?? null);
	return Response.json({ data: body.input.map(() => ({ embedding: [1, 0] })) });
};

const embeddingIndex = (database: Database, fetcher: ModelFetch) => (job: Parameters<typeof embedMemoryJob>[1], signal: AbortSignal) => embedMemoryJob(database, job, fetcher, signal);

const waitAt = () => {
	let release = () => {};
	let started = () => {};
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const reached = new Promise<void>((resolve) => { started = resolve; });
	return { gate, reached, release, started };
};

describe("Memory indexing public lifecycle", () => {
	let database: Database;
	let memories: ReturnType<typeof createMemoryRoutes>;
	let embeddingSettings: ReturnType<typeof createEmbeddingSettingsRoutes>;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
		memories = createMemoryRoutes(database);
		embeddingSettings = createEmbeddingSettingsRoutes(database, { masterKey: key });
	});

	afterEach(() => database.close());

	test("distinguishes an empty saved collection from an indexing result", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		await configureEmbeddings(embeddingSettings, "http://embedding.test/v1/embeddings", "memory-v1");
		const source = insertSource(database, conversation.id, 1, "Maren returned Writer's key.");
		await queueSource(memories, conversation.id, source.messageId);
		const worker = startMemoryWorker(database, { process: async () => [] });
		try {
			expect(await waitFor(async () => (await readSources(memories, conversation.id))[0]?.status === "complete")).toBe(true);
		} finally { await worker(); }
		expect(await readSources(memories, conversation.id)).toMatchObject([
			{ status: "complete", claims: [], indexing: { status: "not-applicable", pendingCount: 0, failedCount: 0 } },
		]);
	});

	test("indexes exact automatic text, reuses compatible vectors, and retries writer edits without extraction", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		await configureEmbeddings(embeddingSettings, "http://embedding.test/v1/embeddings", "memory-v1");
		const first = insertSource(database, conversation.id, 1, "Maren returned Writer's key.");
		const second = insertSource(database, conversation.id, 2, "Writer kept the key safe.");
		await queueSource(memories, conversation.id, first.messageId);
		await queueSource(memories, conversation.id, second.messageId);
		const requests: EmbeddingRequest[] = [];
		let extractions = 0;
		const stop = startMemoryWorker(database, {
			concurrency: 1,
			process: async (source) => { extractions += 1; return [candidate(source.messageId, source.content)]; },
			index: embeddingIndex(database, embeddingFetch(requests)),
		});
		try {
			expect(await waitFor(async () => (await readSources(memories, conversation.id)).every((source) => source.status === "complete" && source.indexing.status === "ready"))).toBe(true);
			expect(extractions).toBe(2);
			expect(requests).toEqual([{
				url: "http://embedding.test/v1/embeddings",
				model: "memory-v1",
				input: ["Maren carries Writer's key. (attribution: Narrated event)"],
				authorization: "Bearer embedding-secret",
			}]);
		} finally { await stop(); }

		const firstCollection = (await readSources(memories, conversation.id)).find((source) => source.variantId === first.variantId);
		if (!firstCollection) throw new Error("Indexed Memory collection missing.");
		const corrected = await memories.handle(request(`/api/conversations/${conversation.id}/memories/correct`, {
			method: "POST",
			body: JSON.stringify({ messageId: first.messageId, variantId: first.variantId, expectedRevision: firstCollection.revision, index: 0, operation: "edit", claim: "Maren now carries the key.", attribution: "Writer correction", people: ["Maren"] }),
		}));
		expect(corrected.status).toBe(200);
		const correctionBody = Value.Parse(memoryCorrectionApplied, await corrected.json());
		expect(correctionBody.collection.indexing.status).toBe("pending");
		let correctionExtractions = 0;
		const failedIndex = startMemoryWorker(database, {
			process: async () => { correctionExtractions += 1; throw new Error("Saved writer text must not be re-extracted."); },
			index: async () => { throw new Error("Controlled indexing failure."); },
		});
		try {
			expect(await waitFor(async () => (await readSources(memories, conversation.id)).find((source) => source.variantId === first.variantId)?.indexing.status === "failed")).toBe(true);
		} finally { await failedIndex(); }
		expect(correctionExtractions).toBe(0);
		const failedCollection = (await readSources(memories, conversation.id)).find((source) => source.variantId === first.variantId);
		if (!failedCollection) throw new Error("Writer Memory collection missing after index failure.");
		expect(failedCollection).toMatchObject({ ownership: "writer", claims: [{ claim: "Maren now carries the key." }], indexing: { status: "failed", failedCount: 1 } });
		const retry = await memories.handle(request(`/api/conversations/${conversation.id}/memories/indexing/retry`, {
			method: "POST",
			body: JSON.stringify({ messageId: first.messageId, variantId: first.variantId, expectedRevision: failedCollection.revision }),
		}));
		expect(retry.status).toBe(200);
		const retryRequests: EmbeddingRequest[] = [];
		const retried = startMemoryWorker(database, {
			process: async () => { correctionExtractions += 1; throw new Error("Retry must use saved writer text."); },
			index: embeddingIndex(database, embeddingFetch(retryRequests)),
		});
		try {
			expect(await waitFor(async () => (await readSources(memories, conversation.id)).find((source) => source.variantId === first.variantId)?.indexing.status === "ready")).toBe(true);
		} finally { await retried(); }
		expect(correctionExtractions).toBe(0);
		expect(retryRequests[0]?.input).toEqual(["Maren now carries the key. (attribution: Writer correction)"]);
	});

	test("keeps already indexed claims recallable while a saved collection is partially rebuilding", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		await configureEmbeddings(embeddingSettings, "http://embedding.test/v1/embeddings", "memory-v1");
		const source = insertSource(database, conversation.id, 1, "Maren held the key.");
		await queueSource(memories, conversation.id, source.messageId);
		const requests: EmbeddingRequest[] = [];
		let extractionPass = 0;
		const initialWorker = startMemoryWorker(database, {
			concurrency: 1,
			process: async (item) => {
				extractionPass += 1;
				return [candidate(item.messageId, item.content)];
			},
			index: embeddingIndex(database, embeddingFetch(requests)),
		});
		try {
			expect(await waitFor(async () => (await readSources(memories, conversation.id))[0]?.indexing.status === "ready")).toBe(true);
		} finally { await initialWorker(); }
		await queueSource(memories, conversation.id, source.messageId);
		const gate = waitAt();
		const rebuilding = startMemoryWorker(database, {
			concurrency: 1,
			process: async (item) => {
				extractionPass += 1;
				return [candidate(item.messageId, item.content), candidate(item.messageId, item.content, "The second Memory is pending.", "Writer correction")];
			},
			index: async (job, signal) => { gate.started(); await gate.gate; return embedMemoryJob(database, job, embeddingFetch(requests), signal); },
		});
		try {
			await gate.reached;
			const current = (await readSources(memories, conversation.id))[0];
			expect(current?.indexing).toMatchObject({ status: "running", pendingCount: 1, failedCount: 0 });
			const snapshot = captureMemoryRecallSnapshot({
				database,
				conversationId: conversation.id,
				enabled: true,
				humanName: "Writer",
				messages: [{ messageId: source.messageId, variantId: source.variantId, position: 1, speakerName: "Maren", role: "model", content: "Maren held the key." }],
			});
			expect(snapshot.activation.readyRecordCount).toBe(1);
			expect(snapshot.indexed.map((item) => item.record.claim)).toEqual(["Maren carries Writer's key."]);
			gate.release();
			expect(await waitFor(async () => (await readSources(memories, conversation.id))[0]?.indexing.status === "ready")).toBe(true);
		} finally { gate.release(); await rebuilding(); }
		expect(extractionPass).toBe(2);
		expect(requests.map((item) => item.input)).toEqual([
			["Maren carries Writer's key. (attribution: Narrated event)"],
			["The second Memory is pending. (attribution: Writer correction)"],
		]);
	});

	test("discards vectors from an old embedding configuration while the current rebuild completes", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		let settings = await configureEmbeddings(embeddingSettings, "http://embedding-a.test/v1/embeddings", "memory-a");
		const source = insertSource(database, conversation.id, 1, "Maren held the key.");
		await queueSource(memories, conversation.id, source.messageId);
		const initial = startMemoryWorker(database, { process: async (item) => [candidate(item.messageId, item.content)], index: async (job) => job.claims.map((claim) => ({ renderedText: renderMemoryClaim(claim), vector: [1, 0] })) });
		try { expect(await waitFor(async () => (await readSources(memories, conversation.id))[0]?.indexing.status === "ready")).toBe(true); }
		finally { await initial(); }
		settings = await configureEmbeddings(embeddingSettings, "http://embedding-b.test/v1/embeddings", "memory-b", settings.revision);
		const oldRequest = waitAt();
		const currentRequest = waitAt();
		const requests: EmbeddingRequest[] = [];
		const transport = embeddingFetch(requests, async (url) => {
			if (url.includes("embedding-b")) { oldRequest.started(); await oldRequest.gate; }
			if (url.includes("embedding-c")) { currentRequest.started(); await currentRequest.gate; }
		});
		const worker = startMemoryWorker(database, { process: async () => { throw new Error("Configuration rebuild must not extract."); }, index: embeddingIndex(database, transport) });
		try {
			await oldRequest.reached;
			settings = await configureEmbeddings(embeddingSettings, "http://embedding-c.test/v1/embeddings", "memory-c", settings.revision);
			await currentRequest.reached;
			oldRequest.release();
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect((await readSources(memories, conversation.id))[0]?.indexing.status).not.toBe("ready");
			currentRequest.release();
			expect(await waitFor(async () => (await readSources(memories, conversation.id))[0]?.indexing.status === "ready")).toBe(true);
		} finally { oldRequest.release(); currentRequest.release(); await worker(); }
		expect(requests.map(({ url, model }) => [url, model])).toEqual([
			["http://embedding-b.test/v1/embeddings", "memory-b"],
			["http://embedding-c.test/v1/embeddings", "memory-c"],
		]);
	});

	test("drops in-flight vectors when a source is edited or deleted", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		let settings = await configureEmbeddings(embeddingSettings, "http://embedding-a.test/v1/embeddings", "memory-a");
		const first = insertSource(database, conversation.id, 1, "Maren returned Writer's key.");
		const second = insertSource(database, conversation.id, 2, "Writer kept the key safe.");
		await queueSource(memories, conversation.id, first.messageId);
		await queueSource(memories, conversation.id, second.messageId);
		const initial = startMemoryWorker(database, {
			concurrency: 1,
			process: async (item) => [candidate(item.messageId, item.content, item.messageId === first.messageId ? "Maren carries the old key." : "Writer keeps the old key.")],
			index: async (job) => job.claims.map((claim) => ({ renderedText: renderMemoryClaim(claim), vector: [1, 0] })),
		});
		try {
			expect(await waitFor(async () => {
				const sources = await readSources(memories, conversation.id);
				return sources.length === 2 && sources.every((source) => source.indexing.status === "ready");
			})).toBe(true);
		}
		finally { await initial(); }
		settings = await configureEmbeddings(embeddingSettings, "http://embedding-b.test/v1/embeddings", "memory-b", settings.revision);
		const indexRequests = waitAt();
		let requestCount = 0;
		const requests: EmbeddingRequest[] = [];
		const transport = embeddingFetch(requests, async (url) => {
			if (!url.includes("embedding-b")) return;
			requestCount += 1;
			if (requestCount === 2) indexRequests.started();
			if (requestCount <= 2) await indexRequests.gate;
		});
		const worker = startMemoryWorker(database, {
			concurrency: 2,
			process: async (item) => [candidate(item.messageId, item.content, "Maren carries the new key.")],
			index: embeddingIndex(database, transport),
		});
		try {
			await indexRequests.reached;
			const conversationRoutes = createConversationRoutes(database);
			const edit = await conversationRoutes.handle(request(`/api/conversations/${conversation.id}/commands`, {
				method: "POST",
				body: JSON.stringify({ expectedRevision: 0, action: { type: "edit-variant", messageId: first.messageId, variantId: first.variantId, content: "Maren now hides Writer's key." } }),
			}));
			expect(edit.status).toBe(200);
			const deletion = await conversationRoutes.handle(request(`/api/conversations/${conversation.id}/commands`, {
				method: "POST",
				body: JSON.stringify({ expectedRevision: 1, action: { type: "delete-message", messageId: second.messageId } }),
			}));
			expect(deletion.status).toBe(200);
			indexRequests.release();
			expect(await waitFor(async () => {
				const sources = await readSources(memories, conversation.id);
				return sources.length === 1 && sources[0]?.status === "complete" && sources[0].indexing.status === "ready";
			})).toBe(true);
		} finally { indexRequests.release(); await worker(); }
		const remaining = await readSources(memories, conversation.id);
		expect(remaining).toMatchObject([{ messageId: first.messageId, ownership: "automatic", claims: [{ claim: "Maren carries the new key." }], sourceChanged: false, indexing: { status: "ready" } }]);
		expect(requests.map(({ input }) => input[0])).toContain("Maren carries the new key. (attribution: Narrated event)");
		expect(remaining.some((source) => source.messageId === second.messageId)).toBe(false);
	});

	test("disabling Memory invalidates a running index and enabling it resumes from saved claims", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		let settings = await configureEmbeddings(embeddingSettings, "http://embedding-a.test/v1/embeddings", "memory-a");
		const source = insertSource(database, conversation.id, 1, "Maren returned Writer's key.");
		await queueSource(memories, conversation.id, source.messageId);
		let extractions = 0;
		const initial = startMemoryWorker(database, {
			process: async (item) => { extractions += 1; return [candidate(item.messageId, item.content)]; },
			index: async (job) => job.claims.map((claim) => ({ renderedText: renderMemoryClaim(claim), vector: [1, 0] })),
		});
		try { expect(await waitFor(async () => (await readSources(memories, conversation.id))[0]?.indexing.status === "ready")).toBe(true); }
		finally { await initial(); }
		settings = await configureEmbeddings(embeddingSettings, "http://embedding-b.test/v1/embeddings", "memory-b", settings.revision);
		const pending = waitAt();
		let indexCalls = 0;
		const requests: EmbeddingRequest[] = [];
		const transport = embeddingFetch(requests, async () => {
			indexCalls += 1;
			if (indexCalls === 1) { pending.started(); await pending.gate; }
		});
		const worker = startMemoryWorker(database, {
			process: async () => { extractions += 1; throw new Error("Re-enabling indexing must use saved claims."); },
			index: embeddingIndex(database, transport),
		});
		try {
			await pending.reached;
			const preset = await readPreset(createConversationRoutes(database), conversation.id);
			const memoryBlock = preset.slots.find((slot) => slot.reference === "memory");
			if (!memoryBlock) throw new Error("The Default recipe has no Memory block.");
			await readOperation(toggleBlock(database, preset.id, memoryBlock.id, false));
			pending.release();
			expect(await waitFor(async () => (await readSources(memories, conversation.id))[0]?.indexing.status === "disabled")).toBe(true);
			expect((await readSources(memories, conversation.id))[0]?.claims).toHaveLength(1);
			const reenabled = await readPreset(createConversationRoutes(database), conversation.id);
			const reenabledMemory = reenabled.slots.find((slot) => slot.reference === "memory");
			if (!reenabledMemory) throw new Error("The Default recipe has no Memory block.");
			await readOperation(toggleBlock(database, reenabled.id, reenabledMemory.id, true));
			expect(await waitFor(async () => (await readSources(memories, conversation.id))[0]?.indexing.status === "ready")).toBe(true);
		} finally { pending.release(); await worker(); }
		expect(extractions).toBe(1);
		expect(indexCalls).toBe(2);
		expect(requests.map(({ url }) => url)).toEqual(["http://embedding-b.test/v1/embeddings", "http://embedding-b.test/v1/embeddings"]);
	});

	test("shares the two-job cap between extraction and indexing and recovers interrupted index work", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		let settings = await configureEmbeddings(embeddingSettings, "http://embedding-a.test/v1/embeddings", "memory-a");
		const indexed = insertSource(database, conversation.id, 1, "Maren held the key.");
		await queueSource(memories, conversation.id, indexed.messageId);
		const initial = startMemoryWorker(database, { process: async (item) => [candidate(item.messageId, item.content)], index: async (job) => job.claims.map((claim) => ({ renderedText: renderMemoryClaim(claim), vector: [1, 0] })) });
		try { expect(await waitFor(async () => (await readSources(memories, conversation.id))[0]?.indexing.status === "ready")).toBe(true); }
		finally { await initial(); }
		settings = await configureEmbeddings(embeddingSettings, "http://embedding-b.test/v1/embeddings", "memory-b", settings.revision);
		const next = insertSource(database, conversation.id, 2, "Writer returned to the room.");
		await queueSource(memories, conversation.id, next.messageId);
		let active = 0;
		let maximum = 0;
		let extractionStarted = () => {};
		let indexStarted = () => {};
		const started = new Promise<void>((resolve) => { extractionStarted = resolve; });
		const indexedStarted = new Promise<void>((resolve) => { indexStarted = resolve; });
		let release = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const enter = async (notify: () => void) => {
			active += 1;
			maximum = Math.max(maximum, active);
			notify();
			try { await gate; } finally { active -= 1; }
		};
		const mixed = startMemoryWorker(database, {
			concurrency: 9,
			process: async (item) => { await enter(extractionStarted); return [candidate(item.messageId, item.content)]; },
			index: async (job) => { await enter(indexStarted); return job.claims.map((claim) => ({ renderedText: renderMemoryClaim(claim), vector: [1, 0] })); },
		});
		try {
			await Promise.all([started, indexedStarted]);
			expect(maximum).toBe(2);
			release();
			expect(await waitFor(async () => (await readSources(memories, conversation.id)).every((source) => source.status === "complete" && source.indexing.status === "ready"))).toBe(true);
		} finally { release(); await mixed(); }
		expect(maximum).toBeLessThanOrEqual(2);
		settings = await configureEmbeddings(embeddingSettings, "http://embedding-c.test/v1/embeddings", "memory-c", settings.revision);
		const restartGate = waitAt();
		const interrupted = startMemoryWorker(database, {
			process: async () => { throw new Error("Restart must recover indexing without extraction."); },
			index: async (_job, signal) => new Promise((_, reject) => {
				restartGate.started();
				signal.addEventListener("abort", () => reject(new Error("Worker stopped.")), { once: true });
			}),
		});
		await restartGate.reached;
		await interrupted();
		const recovered = startMemoryWorker(database, {
			process: async () => { throw new Error("Recovered index work must not extract."); },
			index: async (job) => job.claims.map((claim) => ({ renderedText: renderMemoryClaim(claim), vector: [1, 0] })),
		});
		try {
			expect(await waitFor(async () => (await readSources(memories, conversation.id)).every((source) => source.indexing.status === "ready"))).toBe(true);
		} finally { await recovered(); }
	});
});
