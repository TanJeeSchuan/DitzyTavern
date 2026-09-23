import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { startMemoryWorker } from "../memory";
import { readConversationMemories } from "../memory/collections";
import { createChat, readOperation, readPreset, toggleBlock } from "./prompt-preset-test-fixtures";
import { createMemoryRoutes } from "./memory";
import { createConversationRoutes } from "./conversation";
import { createConnectionSettingsModule } from "../connection-settings";
import { createMemorySettingsModule } from "../memory/settings";
import { extractAndJudgeMemorySource } from "../memory/extraction";
import type { ModelFetch } from "../model-client";
import { key, profile } from "./prompt-preset-test-fixtures";
import { initializeConnectionSecretKey } from "../connection-secrets";

const waitFor = async (check: () => boolean) => {
	const deadline = Date.now() + 4000;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	return check();
};
const insertMessage = (database: Database, conversationId: number, position: number) => {
	const row = database.query<{ id: number }, [number, number]>("INSERT INTO messages (conversation_id, position, timestamp) VALUES (?, ?, '2026-09-23T00:00:00.000Z') RETURNING id").get(conversationId, position);
	if (!row) throw new Error("Memory fixture Message insert failed.");
	return row.id;
};
const insertVariant = (database: Database, messageId: number, content: string, selected: boolean) => {
	const row = database.query<{ id: number }, [number, string, number]>("INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 0, ?, '2026-09-23T00:00:00.000Z', ?) RETURNING id").get(messageId, content, selected ? 1 : 0);
	if (!row) throw new Error("Memory fixture Variant insert failed.");
	return row.id;
};

describe("Memory source public contract", () => {
	let database: Database;
	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("queues a selected retained source and preserves an empty successful collection", async () => {
		const conversation = createChat(database);
		const messageId = insertMessage(database, conversation.id, 1);
		const variantId = insertVariant(database, messageId, "Maren returned the key to Writer.", true);
		const app = createMemoryRoutes(database);
		const queuedResponse = await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/memories/reextract`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId }),
		}));
		expect(queuedResponse.status).toBe(200);
		expect(await queuedResponse.json()).toMatchObject({ outcome: "queued", collection: { variantId, status: "pending", claims: [] } });

		const stop = startMemoryWorker(database, { process: async () => [] });
		try {
			expect(await waitFor(() => readConversationMemories(database, conversation.id)[0]?.status === "complete")).toBe(true);
			expect(readConversationMemories(database, conversation.id)).toMatchObject([{ messageId, variantId, status: "complete", claims: [] }]);
		} finally { await stop(); }
	});

	test("does not queue an unselected alternate or an empty selected source", async () => {
		const conversation = createChat(database);
		const messageId = insertMessage(database, conversation.id, 1);
		insertVariant(database, messageId, "Retained alternate.", false);
		const app = createMemoryRoutes(database);
		const response = await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/memories/reextract`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId }),
		}));
		expect(response.status).toBe(422);
		expect(await response.text()).toContain("selected Variant");

		const emptyMessageId = insertMessage(database, conversation.id, 2);
		insertVariant(database, emptyMessageId, "   ", true);
		const emptyResponse = await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/memories/reextract`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: emptyMessageId }),
		}));
		expect(emptyResponse.status).toBe(422);
		expect(await emptyResponse.text()).toContain("Empty sources are not processed");
	});

	test("captures only the four immediately preceding selected Messages, including empty ones", async () => {
		const conversation = createChat(database);
		const priorIds: number[] = [];
		for (let position = 1; position <= 5; position++) {
			const messageId = insertMessage(database, conversation.id, position);
			priorIds.push(messageId);
			insertVariant(database, messageId, position === 4 ? "" : `Selected context ${position}.`, true);
		}
		const messageId = insertMessage(database, conversation.id, 6);
		insertVariant(database, messageId, "Owning source.", true);
		const queue = createMemoryRoutes(database);
		await queue.handle(new Request(`http://localhost/api/conversations/${conversation.id}/memories/reextract`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId }),
		}));
		let capturedContext: readonly { messageId: number; content: string }[] = [];
		const stop = startMemoryWorker(database, { process: async (_source, context) => { capturedContext = context; return []; } });
		try {
			await waitFor(() => readConversationMemories(database, conversation.id)[0]?.status === "complete" || readConversationMemories(database, conversation.id)[0]?.status === "failed");
			expect(database.query<{ status: string; error: string | null }, [number]>("SELECT status, error FROM memory_collection WHERE conversation_id = ?").get(conversation.id)).toMatchObject({ status: "complete", error: null });
			expect(capturedContext.map(({ messageId: id }) => id)).toEqual(priorIds.slice(1));
			expect(capturedContext.at(-2)?.content).toBe("");
		} finally { await stop(); }
	});

	test("a source edit followed by a text revert still prevents an in-flight result from publishing", async () => {
		const conversation = createChat(database);
		const messageId = insertMessage(database, conversation.id, 1);
		const variantId = insertVariant(database, messageId, "Original story.", true);
		const queue = createMemoryRoutes(database);
		await queue.handle(new Request(`http://localhost/api/conversations/${conversation.id}/memories/reextract`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId }),
		}));
		let release = () => {};
		const waiting = new Promise<void>((resolve) => { release = resolve; });
		const stop = startMemoryWorker(database, { process: async (_source) => { await waiting; return [{ claim: "Late old result.", attribution: "Narrated event", people: [], evidence: [{ messageId, excerpt: "Original story." }], judgment: { support: "supported", usefulness: "retain", probabilities: { "support:supported": 1, "usefulness:retain": 1 } } }]; } });
		try {
			expect(await waitFor(() => database.query<{ status: string }, [number]>("SELECT status FROM memory_collection WHERE variant_id = ?").get(variantId)?.status === "running")).toBe(true);
			const conversationRoutes = createConversationRoutes(database);
			const edit = async (expectedRevision: number, content: string) => conversationRoutes.handle(new Request(`http://localhost/api/conversations/${conversation.id}/commands`, {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision, action: { type: "edit-variant", messageId, variantId, content } }),
			}));
			expect((await edit(0, "Changed story.")).status).toBe(200);
			expect((await edit(1, "Original story.")).status).toBe(200);
			release();
			await stop();
			expect(database.query<{ status: string }, [number]>("SELECT status FROM memory_collection WHERE variant_id = ?").get(variantId)?.status).toBe("pending");
			expect(readConversationMemories(database, conversation.id)).toMatchObject([{ status: "pending", claims: [] }]);
		} finally { release(); await stop(); }
	});

	test("deleting a queued source removes its durable work before a late worker result", async () => {
		const conversation = createChat(database);
		const messageId = insertMessage(database, conversation.id, 1);
		const variantId = insertVariant(database, messageId, "Source to delete.", true);
		const queue = createMemoryRoutes(database);
		await queue.handle(new Request(`http://localhost/api/conversations/${conversation.id}/memories/reextract`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId }),
		}));
		let release = () => {};
		const waiting = new Promise<void>((resolve) => { release = resolve; });
		const stop = startMemoryWorker(database, { process: async () => { await waiting; return []; } });
		try {
			expect(await waitFor(() => database.query<{ status: string }, [number]>("SELECT status FROM memory_collection WHERE variant_id = ?").get(variantId)?.status === "running")).toBe(true);
			const route = createConversationRoutes(database);
			const deleted = await route.handle(new Request(`http://localhost/api/conversations/${conversation.id}/commands`, {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: 0, action: { type: "delete-message", messageId } }),
			}));
			expect(deleted.status).toBe(200);
			release();
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(database.query<{ count: number }, [number]>("SELECT count(*) as count FROM memory_collection WHERE variant_id = ?").get(variantId)).toMatchObject({ count: 0 });
		} finally { release(); await stop(); }
	});

	test("disabling then re-enabling Memory cannot publish work queued before the change", async () => {
		const conversation = createChat(database);
		const messageId = insertMessage(database, conversation.id, 1);
		const variantId = insertVariant(database, messageId, "Source around a setting change.", true);
		const queue = createMemoryRoutes(database);
		await queue.handle(new Request(`http://localhost/api/conversations/${conversation.id}/memories/reextract`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId }),
		}));
		let release = () => {};
		const waiting = new Promise<void>((resolve) => { release = resolve; });
		let processCount = 0;
		const stop = startMemoryWorker(database, { process: async () => { if (++processCount === 1) { await waiting; return [{ claim: "Late pre-disable result.", attribution: "Narrated event", people: [], evidence: [{ messageId, excerpt: "Source around a setting change." }], judgment: { support: "supported", usefulness: "retain", probabilities: { "support:supported": 1, "usefulness:retain": 1 } } }]; } return []; } });
		try {
			expect(await waitFor(() => database.query<{ status: string }, [number]>("SELECT status FROM memory_collection WHERE variant_id = ?").get(variantId)?.status === "running")).toBe(true);
			const preset = await readPreset(createConversationRoutes(database), conversation.id);
			const memory = preset.slots.find((slot) => slot.reference === "memory");
			if (!memory) throw new Error("The Default recipe has no Memory block.");
			await readOperation(toggleBlock(database, preset.id, memory.id, false));
			await readOperation(toggleBlock(database, preset.id, memory.id, true));
			release();
			expect(await waitFor(() => processCount === 2 && database.query<{ status: string }, [number]>("SELECT status FROM memory_collection WHERE variant_id = ?").get(variantId)?.status === "complete")).toBe(true);
			expect(readConversationMemories(database, conversation.id)).toMatchObject([{ status: "complete", claims: [] }]);
		} finally { release(); await stop(); }
	});

	test("captures current extraction settings when each job starts and retains them while running", async () => {
		initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
		const conversation = createChat(database);
		const connectionSettings = createConnectionSettingsModule(database, { masterKey: key });
		const profileId = connectionSettings.createProfile({ expectedRevision: 0, profile, credential: "model-credential" }).profiles[0]?.id;
		if (profileId === undefined) throw new Error("Memory test Connection Profile setup failed.");
		const settings = createMemorySettingsModule(database, { masterKey: key });
		settings.apply({ type: "apply", expectedRevision: 0, extractionProfileId: profileId, extractionModel: "older-model", contextLimit: 16384, outputReserve: 2048, safetyAllowance: 500, jevModel: "jev-1.13.0" });
		const firstMessageId = insertMessage(database, conversation.id, 1);
		const firstVariantId = insertVariant(database, firstMessageId, "First source.", true);
		const secondMessageId = insertMessage(database, conversation.id, 2);
		insertVariant(database, secondMessageId, "Second source.", true);
		const queue = createMemoryRoutes(database);
		const queueSource = (messageId: number) => queue.handle(new Request(`http://localhost/api/conversations/${conversation.id}/memories/reextract`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId }),
		}));
		await queueSource(firstMessageId);
		await new Promise((resolve) => setTimeout(resolve, 5));
		await queueSource(secondMessageId);
		let releaseFirst = () => {};
		let firstRequestStarted = () => {};
		const firstRequestGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
		const firstRequest = new Promise<void>((resolve) => { firstRequestStarted = resolve; });
		const models: string[] = [];
		const fakeFetch: ModelFetch = async (_input, init) => {
			// ==[HUMAN APPROVED]== SAFETY: The controlled Model Client fake receives its ordinary chat-completion JSON request.
			const body = JSON.parse(String(init?.body)) as { model: string };
			models.push(body.model);
			if (models.length === 1) { firstRequestStarted(); await firstRequestGate; }
			const encoder = new TextEncoder();
			const stream = [
				{ choices: [{ index: 0, delta: { content: "{\"candidates\":[]}" }, finish_reason: null }] },
				{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
			return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(stream)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
		};
		const stop = startMemoryWorker(database, { concurrency: 1, process: (source, context, signal) => extractAndJudgeMemorySource(database, source, context, fakeFetch, signal) });
		try {
			await waitFor(() => models.length === 1 || database.query<{ status: string }, [number]>("SELECT status FROM memory_collection WHERE variant_id = ?").get(firstVariantId)?.status === "failed");
			expect(database.query<{ status: string; error: string | null }, [number]>("SELECT status, error FROM memory_collection WHERE variant_id = ?").get(firstVariantId)).toMatchObject({ status: "running", error: null });
			await firstRequest;
			settings.apply({ type: "apply", expectedRevision: 1, extractionProfileId: profileId, extractionModel: "newer-model", contextLimit: 16384, outputReserve: 2048, safetyAllowance: 500, jevModel: "jev-1.13.0" });
			releaseFirst();
			expect(await waitFor(() => models.length === 2)).toBe(true);
			expect(models).toEqual(["older-model", "newer-model"]);
			expect(await waitFor(() => readConversationMemories(database, conversation.id).every((source) => source.status === "complete"))).toBe(true);
		} finally { releaseFirst(); await stop(); }
	});

	test("publishes validated claims with exact evidence and Jev provenance through controlled transports", async () => {
		initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
		const conversation = createChat(database);
		const connectionSettings = createConnectionSettingsModule(database, { masterKey: key });
		const profileId = connectionSettings.createProfile({ expectedRevision: 0, profile, credential: "model-secret" }).profiles[0]?.id;
		if (profileId === undefined) throw new Error("Memory test Connection Profile setup failed.");
		const settings = createMemorySettingsModule(database, { masterKey: key });
		settings.setCredential({ type: "set-credential", expectedRevision: 0, credential: "typesafe-secret" });
		settings.apply({ type: "apply", expectedRevision: 1, extractionProfileId: profileId, extractionModel: "extract-model", contextLimit: 16384, outputReserve: 2048, safetyAllowance: 500, jevModel: "jev-1.13.0" });
		const messageId = insertMessage(database, conversation.id, 1);
		const variantId = insertVariant(database, messageId, "Maren returned Writer's brass key.", true);
		const queue = createMemoryRoutes(database);
		await queue.handle(new Request(`http://localhost/api/conversations/${conversation.id}/memories/reextract`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId }),
		}));
		let typesafeAuthorization: string | null = null;
		const fakeFetch: ModelFetch = async (input, init) => {
			if (String(input).includes("typesafe.ai")) {
				typesafeAuthorization = new Headers(init?.headers).get("authorization");
				return Response.json({ answers: {
					candidate_0_support: { type: "choice", choice: "supported", probabilities: { supported: 0.9, contradicted: 0.05, not_established: 0.05 } },
					candidate_0_usefulness: { type: "choice", choice: "retain", probabilities: { retain: 0.8, omit: 0.2 } },
				} });
			}
			const content = JSON.stringify({ candidates: [{ claim: "Maren returned the brass key to Writer.", attribution: "Narrated event", people: ["Maren", "Writer"], evidence: [{ messageId, excerpt: "Maren returned Writer's brass key." }] }] });
			const encoder = new TextEncoder();
			const stream = [
				{ choices: [{ index: 0, delta: { content }, finish_reason: null }] },
				{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
			return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(stream)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
		};
		const stop = startMemoryWorker(database, { process: (source, context, signal) => extractAndJudgeMemorySource(database, source, context, fakeFetch, signal) });
		try {
			expect(await waitFor(() => readConversationMemories(database, conversation.id)[0]?.status === "complete")).toBe(true);
			expect<string | null>(typesafeAuthorization).toBe("Bearer typesafe-secret");
			expect(readConversationMemories(database, conversation.id)).toMatchObject([{ variantId, status: "complete", claims: [{ claim: "Maren returned the brass key to Writer.", attribution: "Narrated event", people: ["Maren", "Writer"], evidence: [{ messageId, excerpt: "Maren returned Writer's brass key." }], judgment: { support: "supported", usefulness: "retain", probabilities: { "support:supported": 0.9, "usefulness:retain": 0.8 } } }] }]);
			const response = await queue.handle(new Request(`http://localhost/api/conversations/${conversation.id}/memories`));
			expect(await response.text()).not.toContain("typesafe-secret");
		} finally { await stop(); }
	});

	test("rejects valid JSON from a non-successful extraction completion", async () => {
		initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
		const conversation = createChat(database);
		const connectionSettings = createConnectionSettingsModule(database, { masterKey: key });
		const profileId = connectionSettings.createProfile({ expectedRevision: 0, profile, credential: "model-credential" }).profiles[0]?.id;
		if (profileId === undefined) throw new Error("Memory test Connection Profile setup failed.");
		createMemorySettingsModule(database, { masterKey: key }).apply({ type: "apply", expectedRevision: 0, extractionProfileId: profileId, extractionModel: "extract-model", contextLimit: 16384, outputReserve: 2048, safetyAllowance: 500, jevModel: "jev-1.13.0" });
		const messageId = insertMessage(database, conversation.id, 1);
		const variantId = insertVariant(database, messageId, "A valid but incomplete response.", true);
		const queue = createMemoryRoutes(database);
		await queue.handle(new Request(`http://localhost/api/conversations/${conversation.id}/memories/reextract`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId }),
		}));
		const fakeFetch: ModelFetch = async () => {
			const encoder = new TextEncoder();
			const content = JSON.stringify({ candidates: [] });
			const stream = [
				{ choices: [{ index: 0, delta: { content }, finish_reason: null }] },
				{ choices: [{ index: 0, delta: {}, finish_reason: "other" }] },
			].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
			return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(stream)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
		};
		const stop = startMemoryWorker(database, { process: (source, context, signal) => extractAndJudgeMemorySource(database, source, context, fakeFetch, signal) });
		try {
			expect(await waitFor(() => readConversationMemories(database, conversation.id)[0]?.status === "failed")).toBe(true);
			expect(readConversationMemories(database, conversation.id)).toMatchObject([{ variantId, status: "failed", claims: [] }]);
			expect(readConversationMemories(database, conversation.id)[0]?.error).toContain("did not finish successfully");
		} finally { await stop(); }
	});

	test("recovers an interrupted running job after worker restart", async () => {
		const conversation = createChat(database);
		const messageId = insertMessage(database, conversation.id, 1);
		const variantId = insertVariant(database, messageId, "Restart recovery source.", true);
		const queue = createMemoryRoutes(database);
		await queue.handle(new Request(`http://localhost/api/conversations/${conversation.id}/memories/reextract`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId }),
		}));
		const abandoned = startMemoryWorker(database, { process: (_source, _context, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("shutdown")), { once: true })) });
		expect(await waitFor(() => database.query<{ status: string }, [number]>("SELECT status FROM memory_collection WHERE variant_id = ?").get(variantId)?.status === "running")).toBe(true);
		await abandoned();
		expect(database.query<{ status: string }, [number]>("SELECT status FROM memory_collection WHERE variant_id = ?").get(variantId)?.status).toBe("running");
		const recovered = startMemoryWorker(database, { process: async () => [] });
		try {
			expect(await waitFor(() => readConversationMemories(database, conversation.id)[0]?.status === "complete")).toBe(true);
		} finally { await recovered(); }
	});

	test("limits durable processing to two concurrent jobs", async () => {
		const conversation = createChat(database);
		const messageIds = [1, 2, 3].map((position) => {
			const messageId = insertMessage(database, conversation.id, position);
			insertVariant(database, messageId, `Concurrent source ${position}.`, true);
			return messageId;
		});
		const queue = createMemoryRoutes(database);
		for (const messageId of messageIds) await queue.handle(new Request(`http://localhost/api/conversations/${conversation.id}/memories/reextract`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId }),
		}));
		let active = 0;
		let started = 0;
		let maximum = 0;
		let release = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const stop = startMemoryWorker(database, { concurrency: 9, process: async () => {
			active += 1; started += 1; maximum = Math.max(maximum, active);
			try { await gate; return []; } finally { active -= 1; }
		} });
		try {
			expect(await waitFor(() => started === 2)).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 350));
			expect(started).toBe(2);
			release();
			expect(await waitFor(() => readConversationMemories(database, conversation.id).every((source) => source.status === "complete"))).toBe(true);
			expect(maximum).toBe(2);
		} finally { release(); await stop(); }
	});
});
