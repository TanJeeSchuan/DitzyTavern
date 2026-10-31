import type { RecallCandidate } from "./server-recall";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../../server/database/database";
import { initializeConnectionSecretKey } from "../../server/connection-secrets";
import { createConnectionSettingsModule } from "../../server/connection-settings";
import { blankConnectionProfileDraft } from "../../shared/contract/connection-settings";
import { configureDecisionModels } from "../../server/contract/decision-model-test-fixtures";
import { createChat } from "../../server/contract/prompt-preset-test-fixtures";
import { digestNow } from "../../server/test-fixtures/digest";
import type { ModelFetch } from "../../server/model-client";
import { boxServices } from "../../server/box/services";
import { tokenxEstimator } from "../../server/prompt-compiler";
import { applyBoxDecisionSettings, readBoxDecisionSettings } from "../../server/box/decision-settings";
import { createMemorySettingsModule } from "./server-settings";
import { captureMemoryRecallSnapshot, judgeMemoryRecallCandidates } from "./server-recall";
import { memoryRecord } from "./contract";

let database: Database;
const key = new Uint8Array(32).fill(7);
beforeEach(() => {
	database = openInitializedDatabase({ path: ":memory:" });
	initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
});
afterEach(() => database.close());
const decisionOptions = (stateTokenLimit = 16000) => ({ profile: { displayName: "OpenRouter Decisions", requestUrl: "https://openrouter.ai/api/v1/" }, credential: "shared-key", headers: [{ name: "x-title", operation: "replace" as const, value: "DitzyTavern" }], stateTokenLimit });

const content = "Maren kept the brass key.";
const extracted = { claim: "Maren kept the brass key.", attribution: "Narrated event", people: ["Maren"], evidence: [{ messageId: 1, excerpt: content }] };
const extractionResponse = (messageId: number) => new Response([
	{ choices: [{ index: 0, delta: { content: JSON.stringify({ candidates: [{ ...extracted, evidence: [{ messageId, excerpt: content }] }] }) }, finish_reason: null }] },
	{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });

const prepareExtraction = () => {
	configureDecisionModels(database, key, "typesafe/jev-1.13", decisionOptions());
	const connections = createConnectionSettingsModule(database);
	const profile = connections.createProfile({ expectedRevision: connections.get().revision, profile: { ...blankConnectionProfileDraft, displayName: "Extractor", requestUrl: "http://extract.test/v1/" } }).profiles.find(profile => profile.displayName === "Extractor")!;
	const memory = createMemorySettingsModule(database);
	const { revision, ...settings } = memory.get();
	memory.apply({ ...settings, expectedRevision: revision, extractionProfileId: profile.id, extractionModel: "writer" });
};

// @approved
//  Digests one passage in a new Chat and returns its Memory record slot.
const digestPassage = async (passage: string, fetch: (messageId: number) => ModelFetch) => {
	const conversation = createChat(database);
	const message = database.query<{ id: number }, [number]>("INSERT INTO messages (conversation_id, position, timestamp) VALUES (?, 1, '2026-10-06') RETURNING id").get(conversation.id)!;
	const variant = database.query<{ id: number }, [number, string]>("INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 0, ?, '2026-10-06', 1) RETURNING id").get(message.id, passage)!;
	return digestNow(database, conversation.id, "memory", memoryRecord, variant.id, fetch(message.id));
};

const choices = (retain = 0.8, confidence?: number) => ({
	candidate_0_support: { type: "choice", choice: "supported", probabilities: { supported: 0.9, contradicted: 0.02, not_established: 0.02 }, confidence, usage: { cost: 1 } },
	candidate_0_attribution: { type: "choice", choice: "correct", probabilities: { correct: 0.8, misattributed: 0.01, unclear: 0.01 }, confidence },
	candidate_0_usefulness: { type: "choice", choice: "retain", probabilities: { retain, omit: 0.05 }, confidence },
});

test.each([{ retain: 0.8, confidence: 0.01, kept: 1 }, { retain: 0.59, confidence: 1, kept: 0 }, { retain: 0.6, confidence: undefined, kept: 1 }])("Memory uses retain probability $retain regardless of confidence $confidence", async ({ retain, confidence, kept }) => {
	prepareExtraction();
	const slot = await digestPassage(content, (messageId) => async (url, init) => {
		if (!String(url).endsWith("/systemone")) return extractionResponse(messageId);
		expect(String(url)).toBe("https://openrouter.ai/api/v1/systemone");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer shared-key");
		expect(new Headers(init?.headers).get("x-title")).toBe("DitzyTavern");
		expect(JSON.parse(String(init?.body)).model).toBe("typesafe/jev-1.13");
		return Response.json({ answers: choices(retain, confidence), provider: "OpenRouter", latency_ms: 3 });
	});
	const claims = slot?.automatic?.claims ?? [];
	expect(claims).toHaveLength(kept);
	if (kept) {
		expect(claims[0]?.judgment.probabilities["usefulness:retain"]).toBe(retain);
		expect(claims[0]?.judgment.confidence.usefulness).toBe(confidence);
	}
});

test.each(["missing answer", "unasked answer", "unknown option", "missing option", "unknown choice"])("Memory rejects %s without retaining a partial record", async (kind) => {
	prepareExtraction();
	const answers: Record<string, import("../../server/decision-model").DecisionJson> = choices();
	if (kind === "missing answer") delete answers.candidate_0_usefulness;
	if (kind === "unasked answer") answers.unasked = { type: "noul", noul: 0.8 };
	if (kind === "unknown option") answers.candidate_0_usefulness = { type: "choice", choice: "retain", probabilities: { retain: 0.8, strange: 0.2 } };
	if (kind === "missing option") answers.candidate_0_usefulness = { type: "choice", choice: "retain", probabilities: { retain: 0.8 } };
	if (kind === "unknown choice") answers.candidate_0_usefulness = { type: "choice", choice: "strange", probabilities: { retain: 0.8, omit: 0.2 } };
	const slot = await digestPassage(content, (messageId) => async (url) => String(url).endsWith("/systemone") ? Response.json({ answers }) : extractionResponse(messageId));
	expect(slot?.automatic).toBeUndefined();
	expect(slot?.error?.message).toContain("Decision Model");
});

test("recall accepts score answers without confidence or legend and reports the selected profile", async () => {
	const settings = configureDecisionModels(database, key, "typesafe/jev-1.13", decisionOptions(2000));
	const conversation = createChat(database);
	const snapshot = captureMemoryRecallSnapshot({ database, conversationId: conversation.id, seed: "seed", intent: "respond", human: { id: 0, name: "Writer" }, cast: [], messages: [], pending: "A brass key changes hands. ".repeat(2000) });
	expect(snapshot.activation).toMatchObject({ decisionProfileName: "OpenRouter Decisions", decisionModel: "typesafe/jev-1.13", decisionConfigured: true, scanTruncated: true });
	expect(tokenxEstimator(JSON.stringify({ scene: snapshot.activation.scene }))).toBeLessThanOrEqual(2000);
	const candidate: RecallCandidate = { identity: "1:1:0:ab", messageId: 1, variantId: 1, claimIndex: 0, writer: false, sourceChanged: false, claim: extracted.claim, attribution: extracted.attribution, sourcePosition: 1, semanticSimilarity: 1, semanticRank: 1, recentRank: 1, relevance: null, relevanceScore: null, admission: "request-limit" };
	const { decide } = boxServices(database, async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		expect(tokenxEstimator(JSON.stringify(body.state))).toBeLessThanOrEqual(2000);
		return Response.json({ answers: { "candidate_1:1:0:ab_relevance": { type: "score", score: 2, probabilities: { 0: 0.01, 1: 0.02, 2: 0.9, 3: 0.02 }, provider: "Clef" } }, usage: { cost: 0.01 } });
	}, new AbortController().signal)("memory");
	const result = await judgeMemoryRecallCandidates({ candidates: [candidate], scene: snapshot.activation.scene, relevanceMinimum: 1.5, selection: { model: settings.decisionModel, stateTokenLimit: settings.decisionStateTokenLimit }, decide });
	expect(result).toMatchObject([{ relevance: "useful", admission: "admitted" }]);
});

test("an oversized extraction source fails visibly before any request, with no partial record", async () => {
	prepareExtraction();
	const { revision, ...selection } = readBoxDecisionSettings(database, "memory");
	applyBoxDecisionSettings(database, "memory", { type: "apply", expectedRevision: revision, ...selection, decisionStateTokenLimit: 2000 });
	const slot = await digestPassage("Maren kept the key. ".repeat(500), () => async () => { throw new Error("Unexpected network request"); });
	expect(slot?.automatic).toBeUndefined();
	expect(slot?.error?.message).toContain("state token limit");
});
