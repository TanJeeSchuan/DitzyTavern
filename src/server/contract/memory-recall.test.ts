import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { readConversationMemories, startMemoryWorker } from "../memory";
import type { MemoryCandidateJudgment } from "../../shared/contract/memory";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { createConversationModule } from "../conversation";
import { createConversationRoutes } from "./conversation";
import { createMemoryRoutes } from "./memory";
import { configureMemoryEmbeddings, createChat, key, readOperation, readPreset, toggleBlock, withProfile } from "./prompt-preset-test-fixtures";
import { clearGenerationPreviewRegistry } from "../workflows/generation-preview";
import { renderMemoryClaim } from "../../shared/memory-text";
import type { ModelFetch } from "../model-client";
import type { MemoryActivationRecord } from "../../shared/contract/memory-recall";
import type { PromptPlan } from "../../shared/contract/conversation-schema";
import { createTypesafeSettingsModule } from "../typesafe";
import { createMemorySettingsModule } from "../memory/settings";

const waitFor = async (check: () => boolean) => {
	const deadline = Date.now() + 4_000;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	return check();
};

const insertSelectedSource = (database: Database, conversationId: number) => {
	const message = database.query<{ id: number }, [number]>(
		"INSERT INTO messages (conversation_id, position, timestamp) VALUES (?, 1, '2026-09-23T00:00:00.000Z') RETURNING id",
	).get(conversationId);
	if (!message) throw new Error("Memory recall fixture Message insert failed.");
	const variant = database.query<{ id: number }, [number]>(
		"INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 0, 'Maren returned Writer''s key.', '2026-09-23T00:00:00.000Z', 1) RETURNING id",
	).get(message.id);
	if (!variant) throw new Error("Memory recall fixture Variant insert failed.");
	return { messageId: message.id, variantId: variant.id };
};

const insertAlternativeVariant = (database: Database, messageId: number) => {
	const variant = database.query<{ id: number }, [number]>(
		"INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 1, 'The alternate telling says Maren kept a brass key.', '2026-09-23T00:01:00.000Z', 0) RETURNING id",
	).get(messageId);
	if (!variant) throw new Error("Memory recall fixture alternate Variant insert failed.");
	return variant.id;
};

const selectVariant = async (database: Database, conversationId: number, messageId: number, variantId: number) => {
	const revision = createConversationModule(database).getSnapshot(conversationId)?.revision;
	if (revision === undefined) throw new Error("Memory recall selection snapshot missing.");
	const response = await createConversationRoutes(database).handle(new Request(
		`http://localhost/api/conversations/${conversationId}/commands`,
		{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: revision, action: { type: "select-variant", messageId, variantId } }) },
	));
	expect(response.status).toBe(200);
};

const memoryClaim = (messageId: number, claim: string, excerpt: string, attribution = "Narrated event"): MemoryCandidateJudgment => ({
	claim,
	attribution,
	people: ["Maren", "Writer"],
	evidence: [{ messageId, excerpt }],
	judgment: { support: "supported", attribution: "correct", usefulness: "retain", probabilities: { "support:supported": 1, "usefulness:retain": 1 }, confidence: { support: 1, attribution: 1, usefulness: 1 } },
});

const queueAndIndex = async (database: Database, conversationId: number, messageId: number, variantId: number, claim: MemoryCandidateJudgment) => {
	const source = readConversationMemories(database, conversationId).sources.find((item) => item.variantId === variantId);
	if (!source) throw new Error("Memory recall fixture source missing.");
	const queued = await createMemoryRoutes(database).handle(new Request(
		`http://localhost/api/conversations/${conversationId}/memories/reextract`,
		{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId, variantId, expectedRevision: source.revision }) },
	));
	expect(queued.status).toBe(200);
	const worker = startMemoryWorker(database, {
		process: async () => [claim],
		embed: async (texts) => texts.map(() => [1, 0]),
	});
	try {
		expect(await waitFor(() => readConversationMemories(database, conversationId).sources.find((item) => item.variantId === variantId)?.indexing.status === "ready")).toBe(true);
	} finally {
		await worker();
	}
};

const reindexSavedMemories = async (database: Database, conversationId: number, variantId: number) => {
	const worker = startMemoryWorker(database, {
		process: async () => [],
		embed: async (texts) => texts.map(() => [1, 0]),
	});
	try {
		expect(await waitFor(() => readConversationMemories(database, conversationId).sources.find((item) => item.variantId === variantId)?.indexing.status === "ready")).toBe(true);
	} finally {
		await worker();
	}
};

describe("Memory recall in Generation preparation", () => {
	let database: Database;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
	});

	afterEach(() => {
		clearGenerationPreviewRegistry();
		database.close();
	});

	test("recalls indexed claims into the inspected plan and accepts its edited block without recalling again", async () => {
		const conversation = createChat(database);
		const source = insertSelectedSource(database, conversation.id);
		const alternativeVariantId = insertAlternativeVariant(database, source.messageId);
		createTypesafeSettingsModule(database, { masterKey: key }).apply({ type: "apply", expectedRevision: 0, jevModel: "jev-1.13.0", loreTriggerMode: "jev", loreTriggerThreshold: 0.5, credential: "typesafe-secret" });
		configureMemoryEmbeddings(database, "http://embedding.test/v1/embeddings", "test-embedding");
		const memoryRoutes = createMemoryRoutes(database);
		await selectVariant(database, conversation.id, source.messageId, alternativeVariantId);
		await queueAndIndex(database, conversation.id, source.messageId, alternativeVariantId, memoryClaim(source.messageId, "Maren kept a brass key.", "Maren kept a brass key.", "Alternate telling"));
		await selectVariant(database, conversation.id, source.messageId, source.variantId);
		const extraction = memoryClaim(source.messageId, "Maren now holds Writer's key.", "Maren returned Writer's key.");
		await queueAndIndex(database, conversation.id, source.messageId, source.variantId, extraction);
		const collection = readConversationMemories(database, conversation.id).sources.find((item) => item.variantId === source.variantId);
		if (!collection) throw new Error("Indexed Memory source missing.");
		const correction = await memoryRoutes.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/memories/correct`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					messageId: source.messageId,
					variantId: source.variantId,
					expectedRevision: collection.revision,
					index: 0,
					operation: "edit",
					claim: extraction.claim,
					attribution: extraction.attribution,
					people: extraction.people,
				}),
			},
		));
		expect(correction.status).toBe(200);
		const beforeEditRevision = createConversationModule(database).getSnapshot(conversation.id)?.revision;
		if (beforeEditRevision === undefined) throw new Error("Conversation snapshot missing before source edit.");
		const edit = await createConversationRoutes(database).handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/commands`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
				expectedRevision: beforeEditRevision,
					action: { type: "edit-variant", messageId: source.messageId, variantId: source.variantId, content: "Maren hid Writer's key." },
				}),
			},
		));
		expect(edit.status).toBe(200);
		const currentRevision = createConversationModule(database).getSnapshot(conversation.id)?.revision;
		if (currentRevision === undefined) throw new Error("Edited Conversation snapshot missing.");

		let embeddingCalls = 0;
		let jevCalls = 0;
		let writingMessages: { role: string; content: string }[] = [];
		const writingRequests: { role: string; content: string }[][] = [];
		let releaseFirstGeneration = () => {};
		let markFirstGenerationStarted = () => {};
		const firstGenerationGate = new Promise<void>((resolve) => { releaseFirstGeneration = resolve; });
		const firstGenerationStarted = new Promise<void>((resolve) => { markFirstGenerationStarted = resolve; });
		let blockFirstGeneration = true;
		const encoder = new TextEncoder();
		const contentEvent = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "The key stays between them." }, finish_reason: null }] })}\n\n`;
		const finishEvents = [
			{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
		const fetch: ModelFetch = async (input, init) => {
			const url = String(input);
			if (url.includes("embedding.test")) {
				embeddingCalls += 1;
				return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
			}
			if (url.includes("typesafe.ai")) {
				jevCalls += 1;
				// SAFETY: the application builds a JSON object in `questions`; the fake only uses its own question names to form the response.
				const request = JSON.parse(String(init?.body)) as { questions: object };
				const answers = Object.fromEntries(Object.keys(request.questions).map((name) => [name,
					{ type: "score", score: 2, legend: { 0: "Irrelevant", 1: "Incidental", 2: "Useful", 3: "Central" }, probabilities: { 0: 0, 1: 0, 2: 1, 3: 0 }, confidence: 1 },
				]));
				return Response.json({ answers });
			}
			// SAFETY: the generation adapter sends the Messages consumed by the actual writing request.
			const request = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
			writingMessages = request.messages;
			writingRequests.push(request.messages);
			const holdFirstGeneration = blockFirstGeneration;
			blockFirstGeneration = false;
			return new Response(new ReadableStream({
				async start(controller) {
					controller.enqueue(encoder.encode(contentEvent));
					if (holdFirstGeneration) {
						markFirstGenerationStarted();
						await firstGenerationGate;
					}
					controller.enqueue(encoder.encode(finishEvents));
					controller.close();
				},
			}), { headers: { "content-type": "text/event-stream" } });
		};
		withProfile(database);
		const app = createConversationRoutes(database, { masterKey: key, fetch });
		const inspected = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations/preview`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ kind: "send", content: "The next scene begins." }),
			},
		));
		expect(inspected.status).toBe(200);
		// SAFETY: this route response schema validates the preview ID, plan blocks, and activation record.
		const preview = await inspected.json() as {
			previewId: string;
			promptPlan: PromptPlan;
			memoryActivation: MemoryActivationRecord;
			memorySources: { messageId: number; variantId: number | null; exists: boolean }[];
		};
		const memoryText = "Maren now holds Writer's key. (attribution: Narrated event)";
		expect(preview.promptPlan.blocks).toContainEqual({ kind: "memory", role: "system", content: memoryText });
		expect(preview.memoryActivation).toMatchObject({
			state: "ready",
			semanticShortlistCount: 1,
			recentShortlistCount: 1,
			automaticMemoryText: memoryText,
			candidates: [{ messageId: source.messageId, variantId: source.variantId, ownership: "writer", sourceChanged: true, requestIncluded: true, retained: true, relevance: "useful", admission: "admitted" }],
		});
		expect(preview.memoryActivation.candidates.map((candidate) => candidate.variantId)).toEqual([source.variantId]);
		expect(preview.memorySources).toContainEqual({ messageId: source.messageId, variantId: source.variantId, exists: true });
		expect(preview.memorySources).toContainEqual({ messageId: source.messageId, variantId: null, exists: true });
		expect(embeddingCalls).toBe(1);
		expect(jevCalls).toBe(1);

		const editedMemoryText = "Maren still has the key. The writer corrected this one attempt.";
		const editedPlan: PromptPlan = {
			...preview.promptPlan,
			blocks: preview.promptPlan.blocks.map((block) => block.kind === "memory" ? { ...block, content: editedMemoryText } : block),
		};
		const accepted = await app.handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: currentRevision, content: "The next scene begins.", previewId: preview.previewId, promptPlan: editedPlan }),
			},
		));
		expect(accepted.status).toBe(200);
		// SAFETY: the accepted-generation route returns a validated generation ID on success.
		const { generationId } = await accepted.json() as { generationId: number };
		const generationEvents = app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations/${generationId}/events`)).then((response) => response.text());
		await firstGenerationStarted;
		const memoryDuringAttempt = readConversationMemories(database, conversation.id).sources.find((item) => item.variantId === source.variantId);
		if (!memoryDuringAttempt) throw new Error("Memory collection missing during active Generation.");
		const concurrentCorrection = await memoryRoutes.handle(new Request(`http://localhost/api/conversations/${conversation.id}/memories/correct`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
				messageId: source.messageId, variantId: source.variantId, expectedRevision: memoryDuringAttempt.revision,
				index: 0, operation: "edit", claim: "Maren hid Writer's spare key.", attribution: "Writer correction", people: ["Maren", "Writer"],
			}),
		}));
		expect(concurrentCorrection.status).toBe(200);
		const activeInspection = await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations/${generationId}/inspection`));
		expect(activeInspection.status).toBe(200);
		expect(await activeInspection.json()).toMatchObject({ memoryActivation: { manuallyEdited: true, automaticMemoryText: memoryText, finalMemoryText: editedMemoryText } });
		releaseFirstGeneration();
		await generationEvents;
		expect(embeddingCalls).toBe(1);
		expect(jevCalls).toBe(1);
		expect(writingMessages).toContainEqual({ role: "system", content: editedMemoryText });
		expect(writingMessages).not.toContainEqual({ role: "system", content: memoryText });
		const firstTarget = createConversationModule(database).getSnapshot(conversation.id)?.messages.at(-1);
		const firstVariant = firstTarget?.variants.at(-1);
		if (!firstTarget || !firstVariant) throw new Error("The edited Memory Generation Variant was not retained.");
		const permanentDetails = await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/messages/${firstTarget.id}/variants/${firstVariant.id}/details`));
		expect(permanentDetails.status).toBe(200);
		expect(await permanentDetails.json()).toMatchObject({ memoryActivation: {
			manuallyEdited: true,
			automaticMemoryText: memoryText,
			finalMemoryText: editedMemoryText,
			candidates: [{ messageId: source.messageId, variantId: source.variantId, evidence: [{ messageId: source.messageId, excerpt: "Maren returned Writer's key." }] }],
		} });
		const correctedDuringAttempt = readConversationMemories(database, conversation.id).sources.find((item) => item.variantId === source.variantId);
		if (!correctedDuringAttempt) throw new Error("Corrected Memory collection missing after active Generation.");
		const restoreMemory = await memoryRoutes.handle(new Request(`http://localhost/api/conversations/${conversation.id}/memories/correct`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
				messageId: source.messageId, variantId: source.variantId, expectedRevision: correctedDuringAttempt.revision,
				index: 0, operation: "edit", claim: extraction.claim, attribution: extraction.attribution, people: extraction.people,
			}),
		}));
		expect(restoreMemory.status).toBe(200);
		await reindexSavedMemories(database, conversation.id, source.variantId);
		const afterSourceCorrection = await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/messages/${firstTarget.id}/variants/${firstVariant.id}/details`));
		expect(await afterSourceCorrection.json()).toMatchObject({ memoryActivation: { finalMemoryText: editedMemoryText, candidates: [{ claim: "Maren now holds Writer's key.", evidence: [{ excerpt: "Maren returned Writer's key." }] }] } });

		const latest = createConversationModule(database).getSnapshot(conversation.id)?.messages.at(-1);
		const variant = latest?.variants.at(-1);
		if (!latest || !variant) throw new Error("Memory recall Generation Variant was not retained.");
		const targetMemory = memoryClaim(latest.id, "Maren and Writer kept their promise.", "The key stays between them.");
		await queueAndIndex(database, conversation.id, latest.id, variant.id, targetMemory);
		const targetMemoryText = renderMemoryClaim(targetMemory);
		const previewOperation = async (body: { kind: "continuation" } | { kind: "sibling"; messageId: number }) => {
			const response = await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations/preview`, {
				method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
			}));
			expect(response.status).toBe(200);
			// SAFETY: the route response schema checks both preview identity and the complete Memory Activation record.
			return await response.json() as { previewId: string; memoryActivation: MemoryActivationRecord };
		};
		const continuation = await previewOperation({ kind: "continuation" });
		expect(continuation.memoryActivation.candidates.map((candidate) => candidate.messageId)).toContain(source.messageId);
		expect(continuation.memoryActivation.candidates.map((candidate) => candidate.messageId)).toContain(latest.id);
		expect(continuation.memoryActivation.candidates.map((candidate) => candidate.variantId)).not.toContain(alternativeVariantId);
		const continuationRevision = createConversationModule(database).getSnapshot(conversation.id)?.revision;
		if (continuationRevision === undefined) throw new Error("Continuation revision missing.");
		const acceptedContinuation = await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/continue/generations`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: continuationRevision, previewId: continuation.previewId }),
		}));
		if (acceptedContinuation.status !== 200) throw new Error(JSON.stringify(await acceptedContinuation.json()));
		// SAFETY: the successful acceptance route response schema guarantees a generation ID.
		const continuationGeneration = await acceptedContinuation.json() as { generationId: number };
		await (await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations/${continuationGeneration.generationId}/events`))).text();
		const continuationMemoryBlock = writingRequests.at(-1)?.find((message) => message.role === "system" && message.content.includes(memoryText));
		expect(continuationMemoryBlock?.content).toContain(targetMemoryText);
		const continuationTarget = createConversationModule(database).getSnapshot(conversation.id)?.messages.at(-1);
		const continuationVariant = continuationTarget?.variants.at(-1);
		if (!continuationTarget || !continuationVariant) throw new Error("Continuation Memory source was not retained.");
		const laterMemory = memoryClaim(continuationTarget.id, "Maren told Ilya the key was safe.", continuationVariant.content);
		await queueAndIndex(database, conversation.id, continuationTarget.id, continuationVariant.id, laterMemory);
		const sibling = await previewOperation({ kind: "sibling", messageId: latest.id });
		expect(sibling.memoryActivation.candidates.map((candidate) => candidate.messageId)).toEqual([source.messageId]);
		expect(sibling.memoryActivation.candidates.map((candidate) => candidate.variantId)).toEqual([source.variantId]);
		expect(sibling.memoryActivation.scanMessageIds).toContain(source.messageId);
		expect(sibling.memoryActivation.scanMessageIds).not.toContain(latest.id);
		const acceptedSibling = await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/messages/${latest.id}/sibling/generations`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ previewId: sibling.previewId }),
		}));
		if (acceptedSibling.status !== 200) throw new Error(JSON.stringify(await acceptedSibling.json()));
		// SAFETY: the successful acceptance route response schema guarantees a generation ID.
		const siblingGeneration = await acceptedSibling.json() as { generationId: number; messageId: number; variantId: number };
		await (await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations/${siblingGeneration.generationId}/events`))).text();
		expect(writingRequests.at(-1)).toContainEqual({ role: "system", content: memoryText });
		const siblingDetails = await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/messages/${latest.id}/variants/${siblingGeneration.variantId}/details`));
		expect(await siblingDetails.json()).toMatchObject({ memoryActivation: { manuallyEdited: false, finalMemoryText: memoryText, candidates: [{ messageId: source.messageId, variantId: source.variantId }] } });
		expect(embeddingCalls).toBe(3);
		expect(jevCalls).toBe(3);
		const failedApp = createConversationRoutes(database, { masterKey: key, fetch: async () => new Response("provider unavailable", { status: 503 }) });
		const failedRecall = await failedApp.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations/preview`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "continuation" }),
		}));
		expect(failedRecall.status).toBe(422);
		expect(await failedRecall.json()).toMatchObject({ reason: "Memory recall failed: The embedding endpoint rejected the request." });

		const stalePreview = await previewOperation({ kind: "continuation" });
		const currentSourceCollection = readConversationMemories(database, conversation.id).sources.find((item) => item.variantId === source.variantId);
		if (!currentSourceCollection) throw new Error("Current Memory collection missing before stale-preview edit.");
		const changedCollection = await memoryRoutes.handle(new Request(`http://localhost/api/conversations/${conversation.id}/memories/correct`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
				messageId: source.messageId, variantId: source.variantId, expectedRevision: currentSourceCollection.revision,
				index: 0, operation: "edit", claim: "Maren kept the key.", attribution: "Narrated event", people: ["Maren", "Writer"],
			}),
		}));
		expect(changedCollection.status).toBe(200);
		const staleAcceptance = await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/continue/generations`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
				expectedRevision: createConversationModule(database).getSnapshot(conversation.id)?.revision,
				previewId: stalePreview.previewId,
			}),
		}));
		expect(staleAcceptance.status).toBe(422);
		expect(await staleAcceptance.json()).toMatchObject({ outcome: "invalid" });
	});

	test("empty, queued, and disabled recall skip embedding and Jev calls", async () => {
		const conversation = createChat(database);
		const source = insertSelectedSource(database, conversation.id);
		createTypesafeSettingsModule(database, { masterKey: key }).apply({ type: "apply", expectedRevision: 0, jevModel: "jev-1.13.0", loreTriggerMode: "jev", loreTriggerThreshold: 0.5, credential: "typesafe-secret" });
		configureMemoryEmbeddings(database, "http://embedding.test/v1/embeddings", "test-embedding");
		withProfile(database);
		let providerCalls = 0;
		const app = createConversationRoutes(database, { masterKey: key, fetch: async () => { providerCalls += 1; throw new Error("Unexpected Memory provider call."); } });
		const preview = async () => app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations/preview`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "send", content: "A new scene." }),
		}));
		const empty = await preview();
		expect(empty.status).toBe(200);
		expect(await empty.json()).toMatchObject({ memoryActivation: { state: "empty", candidates: [] } });
		const queued = await createMemoryRoutes(database).handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/memories/reextract`,
			{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: source.messageId, variantId: source.variantId, expectedRevision: 0 }) },
		));
		expect(queued.status).toBe(200);
		const rebuilding = await preview();
		expect(rebuilding.status).toBe(200);
		expect(await rebuilding.json()).toMatchObject({ memoryActivation: { state: "rebuilding", readyRecordCount: 0, pendingSourceCount: 1, candidates: [] } });
		const failedWorker = startMemoryWorker(database, {
			process: async () => { throw new Error("Memory extraction unavailable."); },
			embed: async () => [],
		});
		try {
			expect(await waitFor(() => readConversationMemories(database, conversation.id).sources.find((item) => item.variantId === source.variantId)?.status === "failed")).toBe(true);
		} finally {
			await failedWorker();
		}
		const failed = await preview();
		expect(failed.status).toBe(200);
		expect(await failed.json()).toMatchObject({ memoryActivation: { state: "source-failed", readyRecordCount: 0, failedSourceCount: 1, candidates: [] } });
		const routes = createConversationRoutes(database);
		const preset = await readPreset(routes, conversation.id);
		const memoryBlock = preset.slots.find((slot) => slot.reference === "memory");
		if (!memoryBlock) throw new Error("The Default recipe has no Memory block.");
		await readOperation(toggleBlock(database, preset.id, memoryBlock.id, false));
		const disabled = await preview();
		expect(disabled.status).toBe(200);
		expect(await disabled.json()).toMatchObject({ memoryActivation: { state: "disabled", candidates: [] } });
		expect(providerCalls).toBe(0);
	});

	test("turning Memory off stops recall, rejects new extraction, and invalidates running extraction", async () => {
		const conversation = createChat(database);
		const source = insertSelectedSource(database, conversation.id);
		withProfile(database);
		const reextract = () => createMemoryRoutes(database).handle(new Request(
			`http://localhost/api/conversations/${conversation.id}/memories/reextract`,
			{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: source.messageId, variantId: source.variantId, expectedRevision: 0 }) },
		));
		expect((await reextract()).status).toBe(200);
		let release = () => {};
		const waiting = new Promise<void>((resolve) => { release = resolve; });
		const worker = startMemoryWorker(database, { process: async () => { await waiting; return [memoryClaim(source.messageId, "Maren returned Writer's key.", "Maren returned Writer's key.")]; } });
		try {
			expect(await waitFor(() => readConversationMemories(database, conversation.id).sources[0]?.status === "running")).toBe(true);
			createMemorySettingsModule(database).apply({ expectedRevision: 0, enabled: false, extractionProfileId: null, extractionModel: "", contextLimit: 16384, outputReserve: 2048, safetyAllowance: 500, usefulnessConfidenceGate: 0.3, recallRelevanceMinimum: 1.5, embeddingProfileId: null, embeddingModel: "" });
			release();
			await worker();
		} finally { release(); await worker(); }
		expect(readConversationMemories(database, conversation.id).sources).toMatchObject([{ status: "failed", claims: [] }]);
		const rejected = await reextract();
		expect(rejected.status).toBe(422);
		expect(await rejected.text()).toContain("Turn on Memory");
		const preview = await createConversationRoutes(database, { masterKey: key }).handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations/preview`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "send", content: "A new scene." }),
		}));
		expect(await preview.json()).toMatchObject({ memoryActivation: { state: "disabled", candidates: [] } });
	});
});
