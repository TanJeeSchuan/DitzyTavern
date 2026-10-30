import { readTestConversationSnapshot } from "../../server/test-fixtures/conversation";
import { openObservedDatabase, setBoxState } from "../../server/test-fixtures/conversation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import type { MemoryActivationRecord, MemoryCandidateJudgment } from "./contract";
import { initializeConnectionSecretKey } from "../../server/connection-secrets";
import { createConversationRoutes } from "../../server/contract/conversation";
import {
	captureModelFetch,
	configureEmbeddings,
	createChat,
	key,
	readOperation,
	readPreset,
	toggleBlock,
	withProfile,
} from "../../server/contract/prompt-preset-test-fixtures";
import { renderMemoryClaim } from "./shared";
import { formatImageReference } from "../../shared/image-reference";
import type { ModelFetch } from "../../server/model-client";
import type { GenerationJsonValue } from "../../shared/generation-json";
import type { BoxTraces } from "../../shared/contract/box-generation";
import { generationPreview, type PromptPlan } from "../../shared/contract/conversation-schema";
import { configureDecisionModels } from "../../server/contract/decision-model-test-fixtures";
import { createMemorySettingsModule, readMemoryEmbedding } from "./server-settings";
import { mergeMemoryLabels, readConversationMemories, setMemoryAllowance } from "./server-memories";
import { readMemoryChatSettings } from "./server-chat";
import { embedTexts } from "../../server/box/embedding";
import { captureMemoryRecallSnapshot } from "./server-recall";
import { sha256 } from "../../server/hash";
import { applyBoxDecisionSettings, readBoxDecisionSettings } from "../../server/box/decision-settings";
import { resetWriterRecord, writeAutomaticRecord, writeDigestError, writeWriterRecord } from "../../server/box/records";
import { readBoxLifecycles } from "../../server/box/setup";

const configureMemoryEmbeddings = (database: Database, endpoint: string, model: string) => {
	const memory = createMemorySettingsModule(database);
	const { revision, ...settings } = memory.get();
	return memory.apply({ ...settings, expectedRevision: revision, embeddingProfileId: configureEmbeddings(database, endpoint), embeddingModel: model });
};

/** @approved Memory's trace in a preview or inspection read, beside the host's budget evidence for its block. */
const memoryTrace = (read: { boxTraces: BoxTraces }) => read.boxTraces["box:memory"];
const memoryOf = (read: { boxTraces: BoxTraces }) => memoryTrace(read)?.trace;

const insertSelectedSource = (database: Database, conversationId: number, content = "Maren returned Writer's key.") => {
	const message = database.query<{ id: number }, [number]>(
		"INSERT INTO messages (conversation_id, position, timestamp) VALUES (?, 1, '2026-09-23T00:00:00.000Z') RETURNING id",
	).get(conversationId);
	if (!message) throw new Error("Memory recall fixture Message insert failed.");
	const variant = database.query<{ id: number }, [number, string]>(
		"INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 0, ?, '2026-09-23T00:00:00.000Z', 1) RETURNING id",
	).get(message.id, content);
	if (!variant) throw new Error("Memory recall fixture Variant insert failed.");
	return { messageId: message.id, variantId: variant.id };
};

const memoryClaim = (messageId: number, claim: string, excerpt: string, attribution = "Narrated event"): MemoryCandidateJudgment => ({
	claim,
	attribution,
	people: ["Maren", "Writer"],
	evidence: [{ messageId, excerpt }],
	judgment: { support: "supported", attribution: "correct", usefulness: "retain", probabilities: { "support:supported": 1, "usefulness:retain": 1 }, confidence: { support: 1, attribution: 1, usefulness: 1 } },
});

const instanceOf = (database: Database, conversationId: number) => readBoxLifecycles(drizzle(database), conversationId).memory!.instance;
const contentOf = (database: Database, variantId: number) => database.query<{ content: string }, [number]>("SELECT content FROM message_variant WHERE id = ?").get(variantId)!.content;

// @approved
//  What Memory's digest leaves for one Variant: its automatic record for the
//  current text, with the claims it kept already embedded.
const remember = async (database: Database, conversationId: number, variantId: number, claims: MemoryCandidateJudgment[]) => {
	writeAutomaticRecord(drizzle(database), "memory", instanceOf(database, conversationId), variantId, { claims }, sha256(contentOf(database, variantId)));
	const embedding = readMemoryEmbedding(database);
	if (embedding !== undefined) await embedTexts(database, claims.map(renderMemoryClaim), embedding, { cache: true, fetch: async () => Response.json({ data: claims.map(() => ({ embedding: [1, 0] })) }) });
};

const correct = (database: Database, conversationId: number, variantId: number, claims: MemoryCandidateJudgment[]) =>
	writeWriterRecord(drizzle(database), "memory", instanceOf(database, conversationId), variantId, { claims });

/** @approved The embedding batches and Decision Model requests recall sent. */
type RecallCounts = { embedding: string[][]; decisions: number };
const recallCounts = (): RecallCounts => ({ embedding: [], decisions: 0 });

// @approved
//  Embeddings answer one vector per text and the Decision Model scores every
//  recall question useful; writing requests are captured.
const recallFetch = (counts: RecallCounts, writing: ModelFetch = captureModelFetch(() => {})): ModelFetch => async (input, init) => {
	const url = String(input);
	if (url.includes("embedding.test")) {
		// SAFETY: the embedding request carries its text batch as `input`.
		const { input: texts } = JSON.parse(String(init?.body)) as { input: string[] };
		counts.embedding.push(texts);
		return Response.json({ data: texts.map((_, index) => ({ index, embedding: [1, 0] })) });
	}
	if (!url.endsWith("/systemone")) return writing(input, init);
	counts.decisions += 1;
	// SAFETY: the application builds a JSON object in `questions`; the fake only uses its own question names to form the response.
	const { questions } = JSON.parse(String(init?.body)) as { questions: object };
	return Response.json({ answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { type: "score", score: 2, legend: { 0: "Irrelevant", 1: "Incidental", 2: "Useful", 3: "Central" }, probabilities: { 0: 0, 1: 0, 2: 1, 3: 0 }, confidence: 1 }])) });
};

const post = (path: string, body: GenerationJsonValue) => new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("Memory recall in Generation preparation", () => {
	let database: Database;

	beforeEach(() => {
		database = openObservedDatabase();
		initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
	});

	afterEach(() => {
		database.close();
	});

	test("accepts the exact captured Memory after a digest lands in the background", async () => {
		const conversation = createChat(database);
		const source = insertSelectedSource(database, conversation.id);
		configureMemoryEmbeddings(database, "http://embedding.test/v1/embeddings", "test-embedding");
		withProfile(database);
		const requests: { role: string; content: string }[][] = [];
		const app = createConversationRoutes(database, { masterKey: key, fetch: captureModelFetch((request) => requests.push(request.messages)) });
		const inspected = await app.handle(post(`/api/conversations/${conversation.id}/generations/preview`, { kind: "send", content: "The next scene begins." }));
		expect(inspected.status).toBe(200);
		const preview = Value.Parse(generationPreview, await inspected.json());
		expect(memoryOf(preview)).toMatchObject({ state: "rebuilding", candidates: [], pendingSourceCount: 1 });
		await remember(database, conversation.id, source.variantId, [memoryClaim(source.messageId, "Maren returned Writer's key.", "Maren returned Writer's key.")]);
		const editedText = "Keep the inspected context for this attempt.";
		const editedPlan: PromptPlan = { ...preview.promptPlan, blocks: preview.promptPlan.blocks.map((block) => block.kind === "system-instruction" ? { ...block, content: editedText } : block) };
		const accepted = await app.handle(post(`/api/conversations/${conversation.id}/generations`, { kind: "send", expectedRevision: conversation.revision, content: "The next scene begins.", previewId: preview.previewId, promptPlan: editedPlan }));
		expect(accepted.status).toBe(200);
		const { generationId } = await accepted.json();
		await (await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations/${generationId}/events`))).text();
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContainEqual({ role: "system", content: editedText });
		expect(requests[0]).not.toContainEqual({ role: "system", content: "Maren returned Writer's key. (attribution: Narrated event)" });
		const inspection = await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations/${generationId}/inspection`));
		expect(await inspection.json()).toMatchObject({ boxTraces: preview.boxTraces });
	});

	test.each(["settings", "decision-model", "decision-limit", "allowance", "labels", "correction", "reset"] as const)("requires a new preview after an explicit Memory %s change", async (change) => {
		const conversation = createChat(database);
		const source = insertSelectedSource(database, conversation.id);
		const claims = [memoryClaim(source.messageId, "Maren returned Writer's key.", "Maren returned Writer's key.")];
		withProfile(database);
		if (change === "decision-model" || change === "decision-limit") configureDecisionModels(database, key);
		if (change === "reset") correct(database, conversation.id, source.variantId, claims);
		let writingCalls = 0;
		const app = createConversationRoutes(database, { masterKey: key, fetch: captureModelFetch(() => { writingCalls++; }) });
		const inspected = await app.handle(post(`/api/conversations/${conversation.id}/generations/preview`, { kind: "send", content: "The next scene begins." }));
		expect(inspected.status).toBe(200);
		const preview = Value.Parse(generationPreview, await inspected.json());
		if (change === "settings") {
			const memory = createMemorySettingsModule(database);
			const { revision, ...settings } = memory.get();
			memory.apply({ ...settings, expectedRevision: revision, recallRelevanceMinimum: 2 });
		} else if (change === "decision-model" || change === "decision-limit") {
			const { revision, ...selection } = readBoxDecisionSettings(database, "memory");
			applyBoxDecisionSettings(database, "memory", { type: "apply", expectedRevision: revision, ...selection, ...(change === "decision-limit" ? { decisionStateTokenLimit: 2000 } : { decisionModel: "cloudflare/clef-flash" }) });
		} else if (change === "allowance") {
			setMemoryAllowance(database, conversation.id, { expectedRevision: readMemoryChatSettings(database, conversation.id).revision, allowance: 1024 });
		} else if (change === "labels") mergeMemoryLabels(database, conversation.id, { expectedRevision: readConversationMemories(database, conversation.id).labelRevision, labels: ["Maren"], destination: "Mary" });
		else if (change === "correction") correct(database, conversation.id, source.variantId, claims);
		else resetWriterRecord(drizzle(database), "memory", instanceOf(database, conversation.id), source.variantId);
		const accepted = await app.handle(post(`/api/conversations/${conversation.id}/generations`, { kind: "send", expectedRevision: conversation.revision, content: "The next scene begins.", previewId: preview.previewId, promptPlan: preview.promptPlan }));
		expect(accepted.status).toBe(422);
		expect(await accepted.json()).toMatchObject({ reason: "The Prompt Plan is stale. Refresh it before sending." });
		expect(writingCalls).toBe(0);
	});

	test("changing extraction admission keeps inspected Memory without paying for recall again", async () => {
		const conversation = createChat(database);
		const source = insertSelectedSource(database, conversation.id);
		configureDecisionModels(database, key);
		configureMemoryEmbeddings(database, "http://embedding.test/v1/embeddings", "test-embedding");
		withProfile(database);
		await remember(database, conversation.id, source.variantId, [memoryClaim(source.messageId, "Maren returned Writer's key.", "Maren returned Writer's key.")]);
		const counts = recallCounts();
		const app = createConversationRoutes(database, { masterKey: key, fetch: recallFetch(counts) });
		const inspected = await app.handle(post(`/api/conversations/${conversation.id}/generations/preview`, { kind: "send", content: "The next scene begins." }));
		expect(inspected.status).toBe(200);
		const preview = Value.Parse(generationPreview, await inspected.json());
		expect(memoryOf(preview)).toMatchObject({ candidates: [{ relevance: "useful", admission: "admitted" }] });
		const memory = createMemorySettingsModule(database);
		const { revision, ...settings } = memory.get();
		memory.apply({ ...settings, expectedRevision: revision, retainProbabilityMinimum: 0.95 });
		const accepted = await app.handle(post(`/api/conversations/${conversation.id}/generations`, { kind: "send", expectedRevision: conversation.revision, content: "The next scene begins.", previewId: preview.previewId, promptPlan: preview.promptPlan }));
		expect(accepted.status).toBe(200);
		const { generationId } = await accepted.json();
		await (await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations/${generationId}/events`))).text();
		expect(counts.decisions).toBe(1);
	});

	test("recall asks the Decision Model captured with it, even when the selection changes while it embeds", async () => {
		const conversation = createChat(database);
		const source = insertSelectedSource(database, conversation.id);
		configureDecisionModels(database, key);
		configureMemoryEmbeddings(database, "http://embedding.test/v1/embeddings", "test-embedding");
		withProfile(database);
		await remember(database, conversation.id, source.variantId, [memoryClaim(source.messageId, "Maren returned Writer's key.", "Maren returned Writer's key.")]);
		const models: string[] = [];
		const counts = recallCounts();
		const answer = recallFetch(counts);
		const app = createConversationRoutes(database, { masterKey: key, fetch: async (input, init) => {
			if (String(input).includes("embedding.test")) {
				const { revision, ...selection } = readBoxDecisionSettings(database, "memory");
				applyBoxDecisionSettings(database, "memory", { type: "apply", expectedRevision: revision, ...selection, decisionModel: "cloudflare/clef-flash" });
			}
			if (String(input).endsWith("/systemone")) models.push(JSON.parse(String(init?.body)).model);
			return answer(input, init);
		} });
		const preview = Value.Parse(generationPreview, await (await app.handle(post(`/api/conversations/${conversation.id}/generations/preview`, { kind: "send", content: "The next scene begins." }))).json());
		expect(models).toEqual(["jev-1.13.0"]);
		expect(memoryOf(preview)).toMatchObject({ decisionModel: "jev-1.13.0", candidates: [{ admission: "admitted" }] });
	});

	test("recall embeds a corrected claim the cache lacks, once", async () => {
		const conversation = createChat(database);
		const source = insertSelectedSource(database, conversation.id);
		configureDecisionModels(database, key);
		configureMemoryEmbeddings(database, "http://embedding.test/v1/embeddings", "test-embedding");
		withProfile(database);
		await remember(database, conversation.id, source.variantId, [memoryClaim(source.messageId, "Maren returned Writer's key.", "Maren returned Writer's key.")]);
		const corrected = memoryClaim(source.messageId, "Maren still holds the key.", "Maren returned Writer's key.", "Writer correction");
		correct(database, conversation.id, source.variantId, [corrected]);
		const counts = recallCounts();
		const app = createConversationRoutes(database, { masterKey: key, fetch: recallFetch(counts) });
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const inspected = await app.handle(post(`/api/conversations/${conversation.id}/generations/preview`, { kind: "send", content: "The next scene begins." }));
			expect(Value.Parse(generationPreview, await inspected.json()).promptPlan.blocks).toContainEqual({ kind: "box:memory", role: "system", content: renderMemoryClaim(corrected) });
		}
		expect(counts.embedding.filter((texts) => texts.includes(renderMemoryClaim(corrected)))).toEqual([[renderMemoryClaim(corrected)]]);
		expect(counts.embedding).toHaveLength(3);
	});

	test("recall cancels the scene embedding when the claim embedding fails", async () => {
		const conversation = createChat(database);
		const source = insertSelectedSource(database, conversation.id);
		configureDecisionModels(database, key);
		configureMemoryEmbeddings(database, "http://embedding.test/v1/embeddings", "test-embedding");
		withProfile(database);
		await remember(database, conversation.id, source.variantId, [memoryClaim(source.messageId, "Maren returned Writer's key.", "Maren returned Writer's key.")]);
		const corrected = memoryClaim(source.messageId, "Maren still holds the key.", "Maren returned Writer's key.", "Writer correction");
		correct(database, conversation.id, source.variantId, [corrected]);
		const answer = recallFetch(recallCounts());
		let sceneCancelled = false;
		const app = createConversationRoutes(database, { masterKey: key, fetch: async (input, init) => {
			if (!String(input).includes("embedding.test")) return answer(input, init);
			if (String(init?.body).includes(renderMemoryClaim(corrected))) {
				await Bun.sleep(5);
				return new Response("unavailable", { status: 503 });
			}
			return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => { sceneCancelled = true; reject(new Error("Cancelled.")); }, { once: true }));
		} });
		expect((await app.handle(post(`/api/conversations/${conversation.id}/generations/preview`, { kind: "send", content: "The next scene begins." }))).status).toBe(422);
		expect(sceneCancelled).toBe(true);
	});

	test("recall embeds the scene while it embeds claims the cache lacks", async () => {
		const conversation = createChat(database);
		const source = insertSelectedSource(database, conversation.id);
		configureDecisionModels(database, key);
		configureMemoryEmbeddings(database, "http://embedding.test/v1/embeddings", "test-embedding");
		withProfile(database);
		await remember(database, conversation.id, source.variantId, [memoryClaim(source.messageId, "Maren returned Writer's key.", "Maren returned Writer's key.")]);
		const corrected = memoryClaim(source.messageId, "Maren still holds the key.", "Maren returned Writer's key.", "Writer correction");
		correct(database, conversation.id, source.variantId, [corrected]);
		const answer = recallFetch(recallCounts());
		let sceneStarted = false;
		let sceneStartedDuringClaims = false;
		const app = createConversationRoutes(database, { masterKey: key, fetch: async (input, init) => {
			if (String(input).includes("embedding.test")) {
				if (!String(init?.body).includes(renderMemoryClaim(corrected))) sceneStarted = true;
				else {
					await Bun.sleep(20);
					sceneStartedDuringClaims = sceneStarted;
				}
			}
			return answer(input, init);
		} });
		expect((await app.handle(post(`/api/conversations/${conversation.id}/generations/preview`, { kind: "send", content: "The next scene begins." }))).status).toBe(200);
		expect(sceneStartedDuringClaims).toBe(true);
	});

	test("recalls the selected path's effective records into the inspected plan and accepts its edited block without recalling again", async () => {
		const conversation = createChat(database);
		const source = insertSelectedSource(database, conversation.id);
		const alternativeVariantId = database.query<{ id: number }, [number]>(
			"INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 1, 'The alternate telling says Maren kept a brass key.', '2026-09-23T00:01:00.000Z', 0) RETURNING id",
		).get(source.messageId)!.id;
		configureDecisionModels(database, key);
		configureMemoryEmbeddings(database, "http://embedding.test/v1/embeddings", "test-embedding");
		await remember(database, conversation.id, alternativeVariantId, [memoryClaim(source.messageId, "Maren kept a brass key.", "Maren kept a brass key.", "Alternate telling")]);
		const extraction = memoryClaim(source.messageId, "Maren now holds Writer's key.", "Maren returned Writer's key.");
		await remember(database, conversation.id, source.variantId, [extraction]);
		correct(database, conversation.id, source.variantId, [extraction]);
		const edit = await createConversationRoutes(database).handle(post(`/api/conversations/${conversation.id}/commands`, {
			expectedRevision: readTestConversationSnapshot(database, conversation.id)!.revision,
			action: { type: "edit-variant", messageId: source.messageId, variantId: source.variantId, content: "Maren hid Writer's key." },
		}));
		expect(edit.status).toBe(200);
		const currentRevision = readTestConversationSnapshot(database, conversation.id)!.revision;

		const counts = recallCounts();
		const writingRequests: { role: string; content: string }[][] = [];
		const firstGeneration = Promise.withResolvers<void>();
		const firstGenerationStarted = Promise.withResolvers<void>();
		let blockFirstGeneration = true;
		const encoder = new TextEncoder();
		const writing: ModelFetch = async (_input, init) => {
			// SAFETY: the generation adapter sends the Messages consumed by the actual writing request.
			writingRequests.push((JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }).messages);
			const hold = blockFirstGeneration;
			blockFirstGeneration = false;
			return new Response(new ReadableStream({
				async start(controller) {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "The key stays between them." }, finish_reason: null }] })}\n\n`));
					if (hold) { firstGenerationStarted.resolve(); await firstGeneration.promise; }
					controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
					controller.close();
				},
			}), { headers: { "content-type": "text/event-stream" } });
		};
		withProfile(database);
		const app = createConversationRoutes(database, { masterKey: key, fetch: recallFetch(counts, writing) });
		const inspected = await app.handle(post(`/api/conversations/${conversation.id}/generations/preview`, { kind: "send", content: "The next scene begins." }));
		expect(inspected.status).toBe(200);
		const preview = Value.Parse(generationPreview, await inspected.json());
		const memoryText = renderMemoryClaim(extraction);
		expect(preview.promptPlan.blocks).toContainEqual({ kind: "box:memory", role: "system", content: memoryText });
		expect(memoryTrace(preview)).toMatchObject({ automaticText: memoryText, finalText: memoryText, items: [{ text: memoryText, admission: "admitted" }] });
		expect(memoryOf(preview)).toMatchObject({
			state: "ready",
			semanticShortlistCount: 1,
			recentShortlistCount: 1,
			candidates: [{ messageId: source.messageId, variantId: source.variantId, writer: true, sourceChanged: true, relevance: "useful", admission: "admitted" }],
		});
		expect(counts.embedding).toHaveLength(1);
		expect(counts.decisions).toBe(1);

		const editedMemoryText = "Maren still has the key. The writer corrected this one attempt.";
		const editedPlan: PromptPlan = { ...preview.promptPlan, blocks: preview.promptPlan.blocks.map((block) => block.kind === "box:memory" ? { ...block, content: editedMemoryText } : block) };
		const accepted = await app.handle(post(`/api/conversations/${conversation.id}/generations`, { kind: "send", expectedRevision: currentRevision, content: "The next scene begins.", previewId: preview.previewId, promptPlan: editedPlan }));
		expect(accepted.status).toBe(200);
		// SAFETY: the accepted-generation route returns a validated generation ID on success.
		const { generationId } = await accepted.json() as { generationId: number };
		const generationEvents = app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations/${generationId}/events`)).then((response) => response.text());
		await firstGenerationStarted.promise;
		correct(database, conversation.id, source.variantId, [{ ...extraction, claim: "Maren hid Writer's spare key." }]);
		const activeInspection = await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations/${generationId}/inspection`));
		expect(await activeInspection.json()).toMatchObject({ boxTraces: { "box:memory": { automaticText: memoryText, finalText: editedMemoryText } } });
		firstGeneration.resolve();
		await generationEvents;
		expect(counts.embedding).toHaveLength(1);
		expect(counts.decisions).toBe(1);
		expect(writingRequests.at(-1)).toContainEqual({ role: "system", content: editedMemoryText });
		const latest = readTestConversationSnapshot(database, conversation.id)!.messages.at(-1)!;
		const variant = latest.variants.at(-1)!;
		const details = async () => (await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/messages/${latest.id}/variants/${variant.id}/details`))).json();
		expect(await details()).toMatchObject({ boxTraces: { "box:memory": { automaticText: memoryText, finalText: editedMemoryText, trace: { candidates: [{ claim: extraction.claim, evidence: [{ messageId: source.messageId, excerpt: "Maren returned Writer's key." }] }] } } } });
		correct(database, conversation.id, source.variantId, [extraction]);

		await remember(database, conversation.id, variant.id, [memoryClaim(latest.id, "Maren and Writer kept their promise.", "The key stays between them.")]);
		const previewOperation = async (body: { kind: "continuation" } | { kind: "sibling"; messageId: number }) => {
			const response = await app.handle(post(`/api/conversations/${conversation.id}/generations/preview`, body));
			expect(response.status).toBe(200);
			const preview = Value.Parse(generationPreview, await response.json());
			// SAFETY: Memory's advance checked its trace against the activation record schema.
			return { previewId: preview.previewId, memoryActivation: memoryOf(preview) as MemoryActivationRecord };
		};
		const continuation = await previewOperation({ kind: "continuation" });
		expect(continuation.memoryActivation.candidates.map((candidate) => candidate.messageId)).toEqual(expect.arrayContaining([source.messageId, latest.id]));
		expect(continuation.memoryActivation.candidates.map((candidate) => candidate.variantId)).not.toContain(alternativeVariantId);
		const acceptedContinuation = await app.handle(post(`/api/conversations/${conversation.id}/continue/generations`, { kind: "continuation", expectedRevision: readTestConversationSnapshot(database, conversation.id)!.revision, previewId: continuation.previewId }));
		expect(acceptedContinuation.status).toBe(200);
		// SAFETY: the successful acceptance route response schema guarantees a generation ID.
		const continuationGeneration = await acceptedContinuation.json() as { generationId: number };
		await (await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations/${continuationGeneration.generationId}/events`))).text();
		const continued = readTestConversationSnapshot(database, conversation.id)!.messages.at(-1)!;
		await remember(database, conversation.id, continued.variants.at(-1)!.id, [memoryClaim(continued.id, "Maren told Ilya the key was safe.", continued.variants.at(-1)!.content)]);
		const sibling = await previewOperation({ kind: "sibling", messageId: latest.id });
		expect(sibling.memoryActivation.candidates.map((candidate) => [candidate.messageId, candidate.variantId])).toEqual([[source.messageId, source.variantId]]);
		expect(sibling.memoryActivation.scanMessageIds).not.toContain(latest.id);
		expect(counts.embedding).toHaveLength(3);
		expect(counts.decisions).toBe(3);

		const failedApp = createConversationRoutes(database, { masterKey: key, fetch: async () => new Response("provider unavailable", { status: 503 }) });
		const failedRecall = await failedApp.handle(post(`/api/conversations/${conversation.id}/generations/preview`, { kind: "continuation" }));
		expect(failedRecall.status).toBe(422);
		expect(await failedRecall.json()).toMatchObject({ reason: "Memory recall failed: The embedding endpoint rejected the request." });

		const stalePreview = await previewOperation({ kind: "continuation" });
		correct(database, conversation.id, source.variantId, [{ ...extraction, claim: "Maren kept the key." }]);
		const staleAcceptance = await app.handle(post(`/api/conversations/${conversation.id}/continue/generations`, { kind: "continuation", expectedRevision: readTestConversationSnapshot(database, conversation.id)!.revision, previewId: stalePreview.previewId }));
		expect(staleAcceptance.status).toBe(422);
		expect(await staleAcceptance.json()).toMatchObject({ outcome: "invalid" });
	});

	test("empty, pending and failed recall skip embedding and Decision Model calls, and a disabled block captures no Memory", async () => {
		const conversation = createChat(database);
		configureDecisionModels(database, key);
		configureMemoryEmbeddings(database, "http://embedding.test/v1/embeddings", "test-embedding");
		withProfile(database);
		let providerCalls = 0;
		const app = createConversationRoutes(database, { masterKey: key, fetch: async () => { providerCalls += 1; throw new Error("Unexpected Memory provider call."); } });
		const preview = async () => memoryOf(Value.Parse(generationPreview, await (await app.handle(post(`/api/conversations/${conversation.id}/generations/preview`, { kind: "send", content: "A new scene." }))).json()));
		expect(await preview()).toMatchObject({ state: "empty", candidates: [] });
		const source = insertSelectedSource(database, conversation.id);
		expect(await preview()).toMatchObject({ state: "rebuilding", readyRecordCount: 0, pendingSourceCount: 1, candidates: [] });
		writeDigestError(drizzle(database), "memory", instanceOf(database, conversation.id), source.variantId, sha256(contentOf(database, source.variantId)), "Memory extraction unavailable.");
		expect(await preview()).toMatchObject({ state: "source-failed", readyRecordCount: 0, pendingSourceCount: 0, failedSourceCount: 1, candidates: [] });
		const preset = await readPreset(createConversationRoutes(database), conversation.id);
		const memoryBlock = preset.slots.find((slot) => slot.reference === "box:memory");
		if (!memoryBlock) throw new Error("The Default recipe has no Memory block.");
		await readOperation(toggleBlock(database, preset.id, memoryBlock.id, false));
		expect(await preview()).toBeUndefined();
		expect(providerCalls).toBe(0);
	});

	test("a Chat with the Memory Box off recalls nothing", async () => {
		const conversation = createChat(database);
		const source = insertSelectedSource(database, conversation.id);
		await remember(database, conversation.id, source.variantId, [memoryClaim(source.messageId, "Maren returned Writer's key.", "Maren returned Writer's key.")]);
		withProfile(database);
		setBoxState(database, conversation.id, "memory", "disabled");
		const preview = await createConversationRoutes(database, { masterKey: key }).handle(post(`/api/conversations/${conversation.id}/generations/preview`, { kind: "send", content: "A new scene." }));
		expect(memoryTrace(Value.Parse(generationPreview, await preview.json()))).toBeUndefined();
	});

	test("recall reads Images only as Image Anchors, never their hash", () => {
		const conversation = createChat(database);
		const token = formatImageReference("the map", "d".repeat(64));
		const snapshot = captureMemoryRecallSnapshot({
			database,
			conversationId: conversation.id,
			seed: "seed",
			intent: "respond",
			human: { id: 0, name: "Writer" },
			cast: [],
			pending: `Next ${token}`,
			messages: [
				{ messageId: 1, variantId: 1, position: 1, authorId: null, speaker: "Writer", role: "human", content: `Writer unrolled ${token}.`, prose: `Writer unrolled ${token}.`, slot: undefined },
				{ messageId: 2, variantId: 2, position: 2, authorId: null, speaker: "Maren", role: "model", content: `Maren studied ${token} closely.`, prose: `Maren studied ${token} closely.`, slot: undefined },
			],
		});
		expect(snapshot.activation.scene).toBe("Writer: Writer unrolled [Image: the map].\n\nMaren: Maren studied [Image: the map] closely.\n\nWriter: Next [Image: the map]");
	});
});
