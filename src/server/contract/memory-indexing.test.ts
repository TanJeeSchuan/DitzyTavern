import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { embedMemoryTexts, readCachedMemoryVectors, readMemoryEmbeddingConfiguration, readMemoryIndexReadinessBatch } from "../memory/indexing";
import { sha256 } from "../memory/hash";
import { createMemorySettingsModule } from "../memory/settings";
import { captureMemoryRecallSnapshot } from "../memory/recall";
import { startMemoryWorker } from "../memory";
import type { MemoryCandidateJudgment } from "../../shared/contract/memory";
import type { ModelFetch } from "../model-client";
import { formatImageReference } from "../../shared/image-reference";
import { renderMemoryClaim } from "../../shared/memory-text";
import { conversationMemories, memoryCorrectionApplied } from "../../shared/contract/memory";
import { createConversationRoutes } from "./conversation";
import { createMemoryRoutes } from "./memory";
import { createConnectionSettingsRoutes } from "./connection-settings";
import { createConnectionSettingsModule } from "../connection-settings";
import { connectionProfileDraftOf } from "../../shared/contract/connection-settings";
import {
	configureMemoryEmbeddings,
	createChat,
	createRoutes,
	key,
	readOperation,
	readPreset,
	runPresetCommand,
	saveBlockRole,
	toggleBlock,
} from "./prompt-preset-test-fixtures";

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
	const message = database.query<{ id: number }, [number, number]>(
		"INSERT INTO messages (conversation_id, position, timestamp) VALUES (?, ?, '2026-09-23T00:00:00.000Z') RETURNING id").get(conversationId, position);
	if (!message) throw new Error("Memory indexing fixture Message insert failed.");
	const variant = database.query<{ id: number }, [number, string]>(
		"INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 0, ?, '2026-09-23T00:00:00.000Z', 1) RETURNING id")
		.get(message.id, content);
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
		attribution: "correct",
		usefulness: "retain",
		probabilities: { "support:supported": 1, "usefulness:retain": 1 },
		confidence: { support: 1, attribution: 1, usefulness: 1 },
	},
});

const enableMemory = async (database: Database, conversationId: number) => {
	const app = createConversationRoutes(database);
	const preset = await readPreset(app, conversationId);
	const block = preset.slots.find((slot) => slot.reference === "memory");
	if (!block) throw new Error("The Default recipe has no Memory block.");
	if (!block.enabled) await readOperation(toggleBlock(database, preset.id, block.id, true));
};

const queueSource = async (app: ReturnType<typeof createMemoryRoutes>, conversationId: number, messageId: number) => {
	const source = (await readSources(app, conversationId)).find((item) => item.messageId === messageId && item.selected);
	if (!source) throw new Error("Memory source fixture has no selected Variant.");
	const response = await app.handle(request(`/api/conversations/${conversationId}/memories/reextract`, {
		method: "POST",
		body: JSON.stringify({ messageId, variantId: source.variantId, expectedRevision: source.revision }),
	}));
	if (response.status !== 200) throw new Error(`Memory source fixture failed: ${await response.text()}`);
};

const readSources = async (app: ReturnType<typeof createMemoryRoutes>, conversationId: number) => {
	const response = await app.handle(request(`/api/conversations/${conversationId}/memories`));
	if (response.status !== 200) throw new Error(`Memory read fixture failed: ${await response.text()}`);
	return Value.Parse(conversationMemories, await response.json()).sources;
};

type EmbeddingRequest = { url: string; model: string; input: string[]; authorization: string | null };

const preparationFetch = (requests: EmbeddingRequest[], wait?: (url: string, signal: AbortSignal | null) => Promise<void>): ModelFetch => async (input, init) => {
	// SAFETY: the application generated this request from its embedding settings and text batch; this fake reads those typed fields.
	const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
	const url = String(input);
	const headers = new Headers(init?.headers);
	requests.push({ url, model: body.model, input: body.input, authorization: headers.get("authorization") });
	await wait?.(url, init?.signal ?? null);
	return Response.json({ data: body.input.map(() => ({ embedding: [1, 0] })) });
};

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

	beforeEach(() => {
		database = openObservedDatabase();
		initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
		memories = createMemoryRoutes(database);
	});

	afterEach(() => database.close());

	test("reads readiness beyond SQLite's binding limit and preserves later cached claims", () => {
		const configuration = { spaceKey: "long-chat", endpoint: "http://embedding.test/v1/embeddings", model: "memory-v1", deadlineMs: 1000 };
		const collections = Array.from({ length: 65_536 }, (_, index) => ({ variant_id: index + 1, ownership: "automatic" as const, source_changed: false,
			index_attempt_json: null, claims_json: JSON.stringify([candidate(index + 1, "Source evidence.", `Event ${index + 1} occurred.`)]) }));
		const cachedText = renderMemoryClaim(candidate(65_536, "Source evidence.", "Event 65536 occurred."));
		database.query("INSERT INTO memory_embedding_cache (space_key, text_hash, vector) VALUES (?, ?, ?)").run(configuration.spaceKey, sha256(cachedText), Buffer.from(new Float32Array([1, 0]).buffer));
		const readiness = readMemoryIndexReadinessBatch(database, collections, true, configuration);
		expect(readiness.size).toBe(collections.length);
		expect(readiness.get(1)).toMatchObject({ status: "pending", pendingCount: 1 });
		expect(readiness.get(65_536)).toMatchObject({ status: "ready", pendingCount: 0 });
	}, 15_000);

	test.each(["profile", "credential", "header"] as const)("separates vectors when the embedding %s changes", async (change) => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		const settings = configureMemoryEmbeddings(database, "http://embedding.test/v1/embeddings", "memory-v1");
		const source = insertSource(database, conversation.id, 1, "Maren returned Writer's key.");
		await queueSource(memories, conversation.id, source.messageId);
		const worker = startMemoryWorker(database, {
			process: async (item) => [candidate(item.messageId, item.content), candidate(item.messageId, "Writer's key")],
			embed: embedMemoryTexts(database, preparationFetch([])),
		});
		try { expect(await waitFor(async () => (await readSources(memories, conversation.id))[0]?.indexing.status === "ready")).toBe(true); }
		finally { await worker(); }
		const before = readMemoryEmbeddingConfiguration(database);
		const connections = createConnectionSettingsModule(database);
		const profile = connections.get().profiles.find((item) => item.id === settings.embeddingProfileId)!;
		if (change === "profile") {
			const next = connections.createProfile({ expectedRevision: connections.get().revision, profile: { ...connectionProfileDraftOf(profile),
				displayName: "Tenant B" }, credential: "tenant-b" }).profiles.find((item) => item.displayName === "Tenant B")!;
			const memory = createMemorySettingsModule(database);
			const { revision, ...current } = memory.get();
			memory.apply({ ...current, expectedRevision: revision, embeddingProfileId: next.id });
		} else if (change === "credential") {
			connections.setCredential({ expectedRevision: connections.get().revision, profileId: profile.id, credential: "tenant-b" });
		} else {
			connections.applyProfile({ expectedRevision: connections.get().revision, profileId: profile.id, profile: connectionProfileDraftOf(profile),
				headers: [{ operation: "replace", name: "X-Tenant", value: "tenant-b" }] });
		}
		const current = readMemoryEmbeddingConfiguration(database);
		expect(current.spaceKey).not.toBe(before.spaceKey);
		const text = renderMemoryClaim(candidate(source.messageId, ""));
		expect(readCachedMemoryVectors(database, current.spaceKey, [text]).has(text)).toBe(false);
		expect((await readSources(memories, conversation.id))[0]?.indexing).toMatchObject({ status: "pending", pendingCount: 2 });
		const rebuild = startMemoryWorker(database, { process: async () => [], embed: async (texts) => texts.map(() => [0, 1, 0]) });
		try { expect(await waitFor(async () => (await readSources(memories, conversation.id))[0]?.indexing.status === "ready")).toBe(true); }
		finally { await rebuild(); }
		expect(readCachedMemoryVectors(database, current.spaceKey, [text]).get(text)).toEqual([0, 1, 0]);
		expect((await readSources(memories, conversation.id))[0]?.indexing).toMatchObject({ status: "ready", pendingCount: 0 });
		const unchanged = connections.get().profiles.find((item) => item.id === profile.id)!;
		connections.applyProfile({ expectedRevision: connections.get().revision, profileId: profile.id, profile: { ...connectionProfileDraftOf(unchanged), displayName: "Renamed" } });
		expect(readMemoryEmbeddingConfiguration(database)).toEqual(current);
	});

	test("renaming a preset and editing an unrelated block preserve queued extraction", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		const source = insertSource(database, conversation.id, 1, "Maren returned Writer's key.");
		await queueSource(memories, conversation.id, source.messageId);
		const queued = database.query<{ status: string; work_epoch: number }, [number]>(
			"SELECT status, work_epoch FROM memory_collection WHERE variant_id = ?",
		).get(source.variantId);
		if (!queued) throw new Error("Queued Memory source missing.");

		const preset = await readPreset(createConversationRoutes(database), conversation.id);
		const identity = preset.slots.find((slot) => slot.reference === "human-identity");
		if (!identity) throw new Error("The Default recipe has no Human Identity block.");
		const renamed = await runPresetCommand(createRoutes(database).library, {
			type: "rename", presetId: preset.id, expectedRevision: 0, name: "Renamed Default",
		});
		expect(renamed.status).toBe(200);
		await readOperation(saveBlockRole(database, preset.id, identity.id, "assistant"));

		expect(database.query<{ status: string; work_epoch: number }, [number]>(
			"SELECT status, work_epoch FROM memory_collection WHERE variant_id = ?",
		).get(source.variantId)).toEqual(queued);
	});

	test("distinguishes an empty saved collection from an indexing result", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		configureMemoryEmbeddings(database, "http://embedding.test/v1/embeddings", "memory-v1");
		const source = insertSource(database, conversation.id, 1, "Maren returned Writer's key.");
		await queueSource(memories, conversation.id, source.messageId);
		const worker = startMemoryWorker(database, { process: async () => [] });
		try {
			expect(await waitFor(async () => (await readSources(memories, conversation.id))[0]?.status === "complete")).toBe(true);
		} finally { await worker(); }
		expect(await readSources(memories, conversation.id)).toMatchObject([
			{ status: "complete", claims: [], indexing: { status: "not-applicable", pendingCount: 0 } },
		]);
	});

	test("indexes exact automatic text, reuses compatible vectors, and retries writer edits without extraction", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		configureMemoryEmbeddings(database, "http://embedding.test/v1/embeddings", "memory-v1");
		const first = insertSource(database, conversation.id, 1, "Maren returned Writer's key.");
		const second = insertSource(database, conversation.id, 2, "Writer kept the key safe.");
		await queueSource(memories, conversation.id, first.messageId);
		await queueSource(memories, conversation.id, second.messageId);
		const requests: EmbeddingRequest[] = [];
		let extractions = 0;
		const stop = startMemoryWorker(database, {
			concurrency: 1,
			process: async (source) => { extractions += 1; return [candidate(source.messageId, source.content)]; },
			embed: embedMemoryTexts(database, preparationFetch(requests)),
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
			body: JSON.stringify({ messageId: first.messageId, variantId: first.variantId, expectedRevision: firstCollection.revision, index: 0,
				operation: "edit", claim: "Maren now carries the key.", attribution: "Writer correction", people: ["Maren"] }),
		}));
		expect(corrected.status).toBe(200);
		const correctionBody = Value.Parse(memoryCorrectionApplied, await corrected.json());
		expect(correctionBody.collection.indexing.status).toBe("pending");
		let correctionExtractions = 0;
		const failedIndex = startMemoryWorker(database, {
			process: async () => { correctionExtractions += 1; throw new Error("Saved writer text must not be re-extracted."); },
			embed: async () => { throw new Error("Controlled indexing failure."); },
		});
		try {
			expect(await waitFor(async () => (await readSources(memories, conversation.id)).find((source) => source.variantId === first.variantId)?.indexing.status === "failed")).toBe(true);
		} finally { await failedIndex(); }
		expect(correctionExtractions).toBe(0);
		const failedCollection = (await readSources(memories, conversation.id)).find((source) => source.variantId === first.variantId);
		if (!failedCollection) throw new Error("Writer Memory collection missing after index failure.");
		expect(failedCollection).toMatchObject({ ownership: "writer", claims: [{ claim: "Maren now carries the key." }], indexing: { status: "failed" } });
		const retry = await memories.handle(request(`/api/conversations/${conversation.id}/memories/indexing/retry`, {
			method: "POST",
			body: JSON.stringify({ messageId: first.messageId, variantId: first.variantId, expectedRevision: failedCollection.revision }),
		}));
		expect(retry.status).toBe(200);
		const retryRequests: EmbeddingRequest[] = [];
		const retried = startMemoryWorker(database, {
			process: async () => { correctionExtractions += 1; throw new Error("Retry must use saved writer text."); },
			embed: embedMemoryTexts(database, preparationFetch(retryRequests)),
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
		configureMemoryEmbeddings(database, "http://embedding.test/v1/embeddings", "memory-v1");
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
			embed: embedMemoryTexts(database, preparationFetch(requests)),
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
			embed: async (texts, configuration, signal) => { gate.started(); await gate.gate; return embedMemoryTexts(database, preparationFetch(requests))(texts, configuration, signal); },
		});
		try {
			await gate.reached;
			const current = (await readSources(memories, conversation.id))[0];
			expect(current?.indexing).toMatchObject({ status: "running", pendingCount: 1 });
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

	test("editing the chosen Embeddings connection rebuilds indexes at its new endpoint", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		const settings = configureMemoryEmbeddings(database, "http://embedding-a.test/v1/embeddings", "memory-a");
		const source = insertSource(database, conversation.id, 1, "Maren held the key.");
		await queueSource(memories, conversation.id, source.messageId);
		const requests: EmbeddingRequest[] = [];
		const worker = startMemoryWorker(database, { process: async (item) => [candidate(item.messageId, item.content)], embed: embedMemoryTexts(database, preparationFetch(requests)) });
		try {
			expect(await waitFor(async () => (await readSources(memories, conversation.id))[0]?.indexing.status === "ready")).toBe(true);
			const connections = createConnectionSettingsModule(database, { masterKey: key }).get();
			const embeddings = connections.profiles.find((entry) => entry.id === settings.embeddingProfileId);
			if (!embeddings) throw new Error("Embeddings Connection Profile fixture missing.");
			const edited = await createConnectionSettingsRoutes(database, { masterKey: key }).handle(request("/api/connection-settings/commands", {
				method: "POST",
				body: JSON.stringify({ type: "apply-profile", expectedRevision: connections.revision, profileId: embeddings.id,
					profile: { ...connectionProfileDraftOf(embeddings), requestUrl: "http://embedding-b.test/v1/embeddings" } }),
			}));
			expect(edited.status).toBe(200);
			expect(await waitFor(() => requests.some((item) => item.url === "http://embedding-b.test/v1/embeddings"))).toBe(true);
			expect(await waitFor(async () => (await readSources(memories, conversation.id))[0]?.indexing.status === "ready")).toBe(true);
		} finally { await worker(); }
		expect(requests.map((item) => [item.url, item.authorization])).toEqual([
			["http://embedding-a.test/v1/embeddings", "Bearer embedding-secret"],
			["http://embedding-b.test/v1/embeddings", "Bearer embedding-secret"],
		]);
	});

	test("discards vectors from an old embedding configuration while the current rebuild completes", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		configureMemoryEmbeddings(database, "http://embedding-a.test/v1/embeddings", "memory-a");
		const source = insertSource(database, conversation.id, 1, "Maren held the key.");
		await queueSource(memories, conversation.id, source.messageId);
		const initial = startMemoryWorker(database, { process: async (item) => [candidate(item.messageId, item.content)], embed: async (texts) => texts.map(() => [1, 0]) });
		try { expect(await waitFor(async () => (await readSources(memories, conversation.id))[0]?.indexing.status === "ready")).toBe(true); }
		finally { await initial(); }
		configureMemoryEmbeddings(database, "http://embedding-b.test/v1/embeddings", "memory-b");
		const oldRequest = waitAt();
		const currentRequest = waitAt();
		const requests: EmbeddingRequest[] = [];
		const transport = preparationFetch(requests, async (url) => {
			if (url.includes("embedding-b")) { oldRequest.started(); await oldRequest.gate; }
			if (url.includes("embedding-c")) { currentRequest.started(); await currentRequest.gate; }
		});
		const worker = startMemoryWorker(database, { process: async () => { throw new Error("Configuration rebuild must not extract."); }, embed: embedMemoryTexts(database, transport) });
		try {
			await oldRequest.reached;
			configureMemoryEmbeddings(database, "http://embedding-c.test/v1/embeddings", "memory-c");
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
		configureMemoryEmbeddings(database, "http://embedding-a.test/v1/embeddings", "memory-a");
		const first = insertSource(database, conversation.id, 1, "Maren returned Writer's key.");
		const second = insertSource(database, conversation.id, 2, "Writer kept the key safe.");
		await queueSource(memories, conversation.id, first.messageId);
		await queueSource(memories, conversation.id, second.messageId);
		const initial = startMemoryWorker(database, {
			concurrency: 1,
			process: async (item) => [candidate(item.messageId, item.content, item.messageId === first.messageId ? "Maren carries the old key." : "Writer keeps the old key.")],
			embed: async (texts) => texts.map(() => [1, 0]),
		});
		try {
			expect(await waitFor(async () => {
				const sources = await readSources(memories, conversation.id);
				return sources.length === 2 && sources.every((source) => source.indexing.status === "ready");
			})).toBe(true);
		}
		finally { await initial(); }
		configureMemoryEmbeddings(database, "http://embedding-b.test/v1/embeddings", "memory-b");
		const indexRequests = waitAt();
		let requestCount = 0;
		const requests: EmbeddingRequest[] = [];
		const transport = preparationFetch(requests, async (url) => {
			if (!url.includes("embedding-b")) return;
			requestCount += 1;
			if (requestCount === 2) indexRequests.started();
			if (requestCount <= 2) await indexRequests.gate;
		});
		const worker = startMemoryWorker(database, {
			concurrency: 2,
			process: async (item) => [candidate(item.messageId, item.content, "Maren carries the new key.")],
			embed: embedMemoryTexts(database, transport),
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
		configureMemoryEmbeddings(database, "http://embedding-a.test/v1/embeddings", "memory-a");
		const source = insertSource(database, conversation.id, 1, "Maren returned Writer's key.");
		await queueSource(memories, conversation.id, source.messageId);
		let extractions = 0;
		const initial = startMemoryWorker(database, {
			process: async (item) => { extractions += 1; return [candidate(item.messageId, item.content)]; },
			embed: async (texts) => texts.map(() => [1, 0]),
		});
		try { expect(await waitFor(async () => (await readSources(memories, conversation.id))[0]?.indexing.status === "ready")).toBe(true); }
		finally { await initial(); }
		configureMemoryEmbeddings(database, "http://embedding-b.test/v1/embeddings", "memory-b");
		const pending = waitAt();
		let indexCalls = 0;
		const requests: EmbeddingRequest[] = [];
		const transport = preparationFetch(requests, async () => {
			indexCalls += 1;
			if (indexCalls === 1) { pending.started(); await pending.gate; }
		});
		const worker = startMemoryWorker(database, {
			process: async () => { extractions += 1; throw new Error("Re-enabling indexing must use saved claims."); },
			embed: embedMemoryTexts(database, transport),
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
		configureMemoryEmbeddings(database, "http://embedding-a.test/v1/embeddings", "memory-a");
		const indexed = insertSource(database, conversation.id, 1, "Maren held the key.");
		await queueSource(memories, conversation.id, indexed.messageId);
		const initial = startMemoryWorker(database, { process: async (item) => [candidate(item.messageId, item.content)], embed: async (texts) => texts.map(() => [1, 0]) });
		try { expect(await waitFor(async () => (await readSources(memories, conversation.id))[0]?.indexing.status === "ready")).toBe(true); }
		finally { await initial(); }
		configureMemoryEmbeddings(database, "http://embedding-b.test/v1/embeddings", "memory-b");
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
			embed: async (texts) => { await enter(indexStarted); return texts.map(() => [1, 0]); },
		});
		try {
			await Promise.all([started, indexedStarted]);
			expect(maximum).toBe(2);
			release();
			expect(await waitFor(async () => (await readSources(memories, conversation.id)).every((source) => source.status === "complete" && source.indexing.status === "ready"))).toBe(true);
		} finally { release(); await mixed(); }
		expect(maximum).toBeLessThanOrEqual(2);
		configureMemoryEmbeddings(database, "http://embedding-c.test/v1/embeddings", "memory-c");
		const restartGate = waitAt();
		const interrupted = startMemoryWorker(database, {
			process: async () => { throw new Error("Restart must recover indexing without extraction."); },
			embed: async (_texts, _configuration, signal) => new Promise((_, reject) => {
				restartGate.started();
				signal.addEventListener("abort", () => reject(new Error("Worker stopped.")), { once: true });
			}),
		});
		await restartGate.reached;
		await interrupted();
		const recovered = startMemoryWorker(database, {
			process: async () => { throw new Error("Recovered index work must not extract."); },
			embed: async (texts) => texts.map(() => [1, 0]),
		});
		try {
			expect(await waitFor(async () => (await readSources(memories, conversation.id)).every((source) => source.indexing.status === "ready"))).toBe(true);
		} finally { await recovered(); }
	});

	test("extraction and recall read Images only as Image Anchors, never their hash", async () => {
		const conversation = createChat(database);
		await enableMemory(database, conversation.id);
		const hash = "d".repeat(64);
		const token = formatImageReference("the map", hash);
		const earlier = insertSource(database, conversation.id, 1, `Writer unrolled ${token}.`);
		const source = insertSource(database, conversation.id, 2, `Maren studied ${token} closely.`);
		await queueSource(memories, conversation.id, source.messageId);
		const seen: string[] = [];
		const stop = startMemoryWorker(database, {
			concurrency: 1,
			process: async (captured, context) => {
				seen.push(captured.content, ...context.map((message) => message.content));
				return [candidate(captured.messageId, "Maren studied [Image: the map] closely.")];
			},
			embed: async (texts) => texts.map(() => [1, 0]),
		});
		try {
			expect(await waitFor(async () => (await readSources(memories, conversation.id)).find((item) => item.messageId === source.messageId)?.status === "complete")).toBe(true);
		} finally { await stop(); }
		expect(seen).toEqual(["Maren studied [Image: the map] closely.", "Writer unrolled [Image: the map]."]);

		const snapshot = captureMemoryRecallSnapshot({
			database,
			conversationId: conversation.id,
			enabled: true,
			humanName: "Writer",
			pendingHumanText: `Next ${token}`,
			messages: [
				{ messageId: earlier.messageId, variantId: earlier.variantId, position: 1, speakerName: "Writer", role: "human", content: `Writer unrolled ${token}.` },
				{ messageId: source.messageId, variantId: source.variantId, position: 2, speakerName: "Maren", role: "model", content: `Maren studied ${token} closely.` },
			],
		});
		expect(snapshot.activation.scene).toBe(
			"Writer: Writer unrolled [Image: the map].\n\nMaren: Maren studied [Image: the map] closely.\n\nWriter: Next [Image: the map]",
		);
	});
});
