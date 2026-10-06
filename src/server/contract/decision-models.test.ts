import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConnectionSettingsRoutes } from "./connection-settings";
import { blankConnectionProfileDraft } from "../../shared/contract/connection-settings";
import { createMemorySettingsModule } from "../memory/settings";
import { extractAndJudgeMemorySource } from "../memory/extraction";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { createConnectionSettingsModule } from "../connection-settings";
import { captureSemanticSettings, evaluateSemanticLore } from "../lorebook/semantic";
import { createSemanticTriggerSettingsModule } from "../lorebook/semantic-settings";
import { captureMemoryRecallSnapshot, judgeMemoryRecallCandidates } from "../memory/recall";
import { tokenxEstimator } from "../prompt-compiler";
import type { MemoryRecallCandidateRecord } from "../../shared/contract/memory-recall";
import type { GenerationJsonValue } from "../../shared/generation-json";
import { resolveDecisionSelection } from "../decision-model";
import { configureDecisionModels } from "./decision-model-test-fixtures";
import { createChat } from "./prompt-preset-test-fixtures";
import { startMemoryWorker } from "../memory";
import { createMemoryRoutes } from "./memory";
import { readConversationMemories } from "../memory/collections";
import { createConversationModule } from "../conversation";

let database: Database;
const key = new Uint8Array(32).fill(7);
beforeEach(() => {
	database = openInitializedDatabase({ path: ":memory:" });
	initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
});
afterEach(() => database.close());
const post = (path: string, data: GenerationJsonValue) => new Request(`http://localhost/api/connection-settings/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

test("Memory extraction reports a missing Decision Model before requesting extraction", async () => {
	await expect(extractAndJudgeMemorySource(database, { messageId: 1, variantId: 1, speaker: "Maren", content: "Maren kept the key." }, [], async () => { throw new Error("Unexpected network request"); })).rejects.toThrow("Decision Model in Memory Settings");
});

test("decision presets save independently and require a positive timeout", async () => {
	const app = createConnectionSettingsRoutes(database, { masterKey: new Uint8Array(32).fill(7) });
	const { presets } = await (await app.handle(new Request("http://localhost/api/connection-settings/presets"))).json();
	const decisions = presets.filter((preset: { profile: { apiFormat: string } }) => preset.profile.apiFormat === "system-one");
	expect(decisions.map((preset: { label: string }) => preset.label)).toEqual(["OpenRouter Decisions", "TypeSafe", "System One endpoint"]);
	let revision = 0;
	for (const { profile } of decisions) {
		const saved = await app.handle(post("commands", { type: "create-profile", expectedRevision: revision++, profile: { ...profile, displayName: profile.displayName || "Local" } }));
		expect(saved.status).toBe(200);
		for (const timeoutMs of [null, 0, -1]) {
			const invalid = await app.handle(post("commands", { type: "create-profile", expectedRevision: revision, profile: { ...profile, displayName: "Invalid", timeoutMs } }));
			expect(invalid.status).toBe(422);
			expect(await invalid.text()).toContain("positive timeout");
		}
	}
});

test("a keyless System One profile saves and tests a real decision at its resolved URL", async () => {
	const profile = { ...blankConnectionProfileDraft, displayName: "Local decisions", apiFormat: "system-one", requestUrl: "http://localhost:8000/v1/", timeoutMs: 15000 };
	const app = createConnectionSettingsRoutes(database, { masterKey: new Uint8Array(32).fill(7), fetch: async (url, init) => {
		expect(String(url)).toBe("http://localhost:8000/v1/systemone");
		expect(new Headers(init?.headers).has("authorization")).toBe(false);
		expect(new Headers(init?.headers).get("x-gateway")).toBe("local-token");
		const body = JSON.parse(String(init?.body));
		expect(body).toMatchObject({ model: "clef", state: "ping" });
		expect(Object.values(body.questions)).toMatchObject([{ type: "noul" }]);
		return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0.9, provider: "local" }])), latency_ms: 12 });
	} });
	const saved = await app.handle(post("commands", { type: "create-profile", expectedRevision: 0, profile, headers: [{ name: "x-gateway", operation: "replace", value: "local-token" }] }));
	expect(saved.status).toBe(200);
	const id = (await saved.json()).settings.profiles[0].id;
	const tested = await app.handle(post("test-connection", { profileId: id, profile, modelId: "clef" }));
	expect(await tested.json()).toMatchObject({ outcome: "success" });
});

test("Test Connection reports the profile deadline when a Decision Model hangs", async () => {
	const app = createConnectionSettingsRoutes(database, { fetch: async () => new Promise<Response>(() => {}) });
	const tested = await app.handle(post("test-connection", { profile: { ...blankConnectionProfileDraft, displayName: "Slow local", apiFormat: "system-one", requestUrl: "http://localhost:8000/decision", timeoutMs: 5 }, modelId: "clef" }));
	expect(await tested.json()).toMatchObject({ outcome: "failure", kind: "timeout", message: expect.stringContaining("timed out") });
});

test.each([
	{ answers: {}, reason: "omitted or added" },
	{ answers: { ping: { type: "noul", noul: 0.9 }, unasked: { type: "noul", noul: 0.2 } }, reason: "omitted or added" },
	{ answers: { ping: { type: "noul", noul: 1.1 } }, reason: "ping/noul" },
])("Test Connection rejects unreadable answers with a reason: $reason", async ({ answers, reason }) => {
	const app = createConnectionSettingsRoutes(database, { fetch: async (url) => {
		expect(String(url)).toBe("http://localhost:8000/custom-decision");
		return Response.json({ answers });
	} });
	const tested = await app.handle(post("test-connection", { profile: { ...blankConnectionProfileDraft, displayName: "Local", apiFormat: "system-one", requestUrl: "http://localhost:8000/custom-decision", timeoutMs: 15000 }, modelId: "clef" }));
	expect(await tested.json()).toMatchObject({ outcome: "failure", message: expect.stringContaining(reason) });
});

test.each([true, "0.9"])("Test Connection rejects a non-numeric noul probability %s", async noul => {
	const app = createConnectionSettingsRoutes(database, { fetch: async () => Response.json({ answers: { ping: { type: "noul", noul } } }) });
	const tested = await app.handle(post("test-connection", { profile: { ...blankConnectionProfileDraft, displayName: "Local", apiFormat: "system-one", requestUrl: "http://localhost:8000/decision", timeoutMs: 15000 }, modelId: "clef" }));
	expect(await tested.json()).toMatchObject({ outcome: "failure", kind: "malformed-response" });
});

test.each([
	{ body: "not JSON", reason: "invalid JSON" },
	{ body: JSON.stringify({ answers: { ping: { type: "noul", probability: 0.9 } } }), reason: "ping/noul" },
])("Test Connection identifies an unreadable response: $reason", async ({ body, reason }) => {
	const app = createConnectionSettingsRoutes(database, { fetch: async () => new Response(body) });
	const tested = await app.handle(post("test-connection", { profile: { ...blankConnectionProfileDraft, displayName: "Local", apiFormat: "system-one", requestUrl: "http://localhost:8000/decision", timeoutMs: 15000 }, modelId: "clef" }));
	expect(await tested.json()).toMatchObject({ outcome: "failure", kind: "malformed-response", message: expect.stringContaining(reason) });
});

const decisionOptions = (stateTokenLimit = 16000) => ({ profile: { displayName: "OpenRouter Decisions", requestUrl: "https://openrouter.ai/api/v1/" }, credential: "shared-key", headers: [{ name: "x-title", operation: "replace" as const, value: "DitzyTavern" }], stateTokenLimit });

const source = { messageId: 1, variantId: 1, speaker: "Maren", content: "Maren kept the brass key." };
const extracted = { claim: "Maren kept the brass key.", attribution: "Narrated event", people: ["Maren"], evidence: [{ messageId: 1, excerpt: source.content }] };
const extractionResponse = () => new Response([
	{ choices: [{ index: 0, delta: { content: JSON.stringify({ candidates: [extracted] }) }, finish_reason: null }] },
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

const choices = (retain = 0.8, confidence?: number) => ({
	candidate_0_support: { type: "choice", choice: "supported", probabilities: { supported: 0.9, contradicted: 0.02, not_established: 0.02 }, confidence, usage: { cost: 1 } },
	candidate_0_attribution: { type: "choice", choice: "correct", probabilities: { correct: 0.8, misattributed: 0.01, unclear: 0.01 }, confidence },
	candidate_0_usefulness: { type: "choice", choice: "retain", probabilities: { retain, omit: 0.05 }, confidence },
});

test.each([{ retain: 0.8, confidence: 0.01, kept: 1 }, { retain: 0.59, confidence: 1, kept: 0 }, { retain: 0.6, confidence: undefined, kept: 1 }])("Memory uses retain probability $retain regardless of confidence $confidence", async ({ retain, confidence, kept }) => {
	prepareExtraction();
	const result = await extractAndJudgeMemorySource(database, source, [], async (url, init) => {
		if (!String(url).endsWith("/systemone")) return extractionResponse();
		expect(String(url)).toBe("https://openrouter.ai/api/v1/systemone");
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer shared-key");
		expect(new Headers(init?.headers).get("x-title")).toBe("DitzyTavern");
		expect(JSON.parse(String(init?.body)).model).toBe("typesafe/jev-1.13");
		return Response.json({ answers: choices(retain, confidence), provider: "OpenRouter", latency_ms: 3 });
	});
	expect(result).toHaveLength(kept);
	if (kept) {
		expect(result[0]?.judgment.probabilities["usefulness:retain"]).toBe(retain);
		expect(result[0]?.judgment.confidence.usefulness).toBe(confidence);
	}
});

test.each(["missing answer", "unasked answer", "unknown option", "missing option", "unknown choice"])("Memory rejects $kind without retaining a partial collection", async (kind) => {
	prepareExtraction();
	const answers: Record<string, import("../decision-model").DecisionJson> = choices();
	if (kind === "missing answer") delete answers.candidate_0_usefulness;
	if (kind === "unasked answer") answers.unasked = { type: "noul", noul: 0.8 };
	if (kind === "unknown option") answers.candidate_0_usefulness = { type: "choice", choice: "retain", probabilities: { retain: 0.8, strange: 0.2 } };
	if (kind === "missing option") answers.candidate_0_usefulness = { type: "choice", choice: "retain", probabilities: { retain: 0.8 } };
	if (kind === "unknown choice") answers.candidate_0_usefulness = { type: "choice", choice: "strange", probabilities: { retain: 0.8, omit: 0.2 } };
	await expect(extractAndJudgeMemorySource(database, source, [], async url => String(url).endsWith("/systemone") ? Response.json({ answers }) : extractionResponse())).rejects.toThrow("Decision Model");
});

test("recall accepts score answers without confidence or legend and reports the selected profile", async () => {
	const settings = configureDecisionModels(database, key, "typesafe/jev-1.13", decisionOptions(2000));
	const conversation = createChat(database);
	const snapshot = captureMemoryRecallSnapshot({ database, conversationId: conversation.id, enabled: true, messages: [], pendingHumanText: "A brass key changes hands. ".repeat(2000), humanName: "Writer" });
	expect(snapshot.activation).toMatchObject({ decisionProfileName: "OpenRouter Decisions", decisionModel: "typesafe/jev-1.13", decisionConfigured: true, scanTruncated: true });
	expect(tokenxEstimator(JSON.stringify({ scene: snapshot.activation.scene }))).toBeLessThanOrEqual(2000);
	const candidate: MemoryRecallCandidateRecord = { identity: "1:1:1:0", messageId: 1, variantId: 1, collectionRevision: 1, claimIndex: 0, ownership: "automatic", sourceChanged: false, ...extracted, sourcePosition: 1, semanticSimilarity: 1, semanticRank: 1, recentRank: 1, relevance: null, relevanceScore: null, admission: "request-limit" };
	const result = await judgeMemoryRecallCandidates({ candidates: [candidate], scene: snapshot.activation.scene, relevanceMinimum: 1.5, selection: resolveDecisionSelection(database, settings)!, fetch: async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		expect(tokenxEstimator(JSON.stringify(body.state))).toBeLessThanOrEqual(2000);
		return Response.json({ answers: { "candidate_1:1:1:0_relevance": { type: "score", score: 2, probabilities: { 0: 0.01, 1: 0.02, 2: 0.9, 3: 0.02 }, provider: "Clef" } }, usage: { cost: 0.01 } });
	} });
	expect(result).toMatchObject([{ relevance: "useful", admission: "admitted" }]);
});

test("Semantic Triggers use Clef Flash with the Memory profile key, chunk the entire scene, and clear to keyword-only matching", async () => {
	const memory = configureDecisionModels(database, key, "typesafe/jev-1.13", decisionOptions(2000));
	const semantic = createSemanticTriggerSettingsModule(database);
	semantic.apply({ type: "apply", expectedRevision: semantic.get().revision, decisionProfileId: memory.decisionProfileId, decisionModel: "cloudflare/clef-flash", decisionStateTokenLimit: 2000, triggerThreshold: 0.75 });
	let requests = 0;
	const input = { entries: [{ enabled: true, semanticTriggers: ["ships arrive"] }], messages: [{ content: "The ship arrives. ".repeat(4000) }] };
	const result = await evaluateSemanticLore({ ...input, settings: captureSemanticSettings(database), fetch: async (_url, init) => {
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer shared-key");
		const body = JSON.parse(String(init?.body));
		expect(body.model).toBe("cloudflare/clef-flash");
		expect(tokenxEstimator(JSON.stringify(body.state))).toBeLessThanOrEqual(2000);
		return Response.json({ answers: { trigger_0: { type: "noul", noul: ++requests === 1 ? 0.9 : 0.1 } }, provider: "OpenRouter" });
	} });
	expect(requests).toBeGreaterThan(1);
	expect(result).toEqual({ available: true, threshold: 0.75, matches: [{ trigger: "ships arrive", score: 0.9 }] });
	semantic.apply({ type: "apply", expectedRevision: semantic.get().revision, decisionProfileId: null, decisionModel: "", decisionStateTokenLimit: 2000, triggerThreshold: 0.75 });
	expect(await evaluateSemanticLore({ ...input, settings: captureSemanticSettings(database), fetch: async () => { throw new Error("Unexpected decision request"); } })).toMatchObject({ available: false, fallbackReason: expect.stringContaining("turned off") });
});

test("an oversized extraction source fails visibly with no partial collection", async () => {
	configureDecisionModels(database, key, "typesafe/jev-1.13", decisionOptions(2000));
	const conversation = createChat(database);
	const content = "Maren kept the key. ".repeat(3000);
	const message = database.query<{ id: number }, [number]>("INSERT INTO messages (conversation_id, position, timestamp) VALUES (?, 1, '2026-10-06') RETURNING id").get(conversation.id)!;
	const variant = database.query<{ id: number }, [number, string]>("INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 0, ?, '2026-10-06', 1) RETURNING id").get(message.id, content)!;
	const app = createMemoryRoutes(database);
	const queued = await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/memories/reextract`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId: message.id, variantId: variant.id, expectedRevision: 0 }) }));
	expect(queued.status).toBe(200);
	const stop = startMemoryWorker(database, { process: (source, context, signal) => extractAndJudgeMemorySource(database, source, context, async () => { throw new Error("Unexpected network request"); }, signal) });
	try {
		const deadline = Date.now() + 3000;
		while (readConversationMemories(database, conversation.id).sources[0]?.status !== "failed" && Date.now() < deadline) await Bun.sleep(10);
		const reported = await (await app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/memories`))).json();
		expect(reported.sources).toMatchObject([{ status: "failed", error: expect.stringContaining("state token limit"), claims: [] }]);
	} finally { await stop(); }
});

test("creating a Chat never selects a Decision Model as its writing connection", () => {
	configureDecisionModels(database, key, "typesafe/jev-1.13", decisionOptions());
	const conversation = createChat(database);
	expect(createConversationModule(database).getGenerationSettings(conversation.id)?.connectionProfileId).toBeNull();
});

test.each([{ status: 401, kind: "authentication" }, { status: 403, kind: "authentication" }, { status: 503, kind: "endpoint" }, { status: 0, kind: "endpoint" }])("Test Connection categorizes a Decision Model failure with status $status", async ({ status, kind }) => {
	const app = createConnectionSettingsRoutes(database, { fetch: async () => {
		if (status === 0) throw new TypeError("Connection refused");
		return Response.json({ error: "Unavailable" }, { status });
	} });
	const tested = await app.handle(post("test-connection", { profile: { ...blankConnectionProfileDraft, displayName: "Local", apiFormat: "system-one", requestUrl: "http://localhost:8000/decision", timeoutMs: 15000 }, modelId: "clef" }));
	expect(await tested.json()).toMatchObject({ outcome: "failure", kind });
});
