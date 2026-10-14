import { readConversationGenerationSettings } from "../conversation";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createConnectionSettingsRoutes } from "./connection-settings";
import { blankConnectionProfileDraft } from "../../shared/contract/connection-settings";
import { createMemorySettingsModule } from "../../boxes/memory/server-settings";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { createConnectionSettingsModule } from "../connection-settings";
import { captureSemanticSettings, evaluateSemanticLore } from "../lorebook/semantic";
import { createSemanticTriggerSettingsModule } from "../lorebook/semantic-settings";
import { captureMemoryRecallSnapshot, judgeMemoryRecallCandidates } from "../../boxes/memory/server-recall";
import { tokenxEstimator } from "../prompt-compiler";
import { memoryRecord, type MemoryRecallCandidateRecord } from "../../boxes/memory/contract";
import type { GenerationJsonValue } from "../../shared/generation-json";
import { boxServices } from "../box/services";
import { configureDecisionModels } from "./decision-model-test-fixtures";
import { createChat } from "./prompt-preset-test-fixtures";
import { applyBoxDecisionSettings, readBoxDecisionSettings } from "../box/decision-settings";
import { digestNow } from "../test-fixtures/digest";
import type { ModelFetch } from "../model-client";
import { testConnection } from "../model-client/test-connection";
import { prepareGenerationInputsSnapshot } from "../workflows/generate-capture";
import { generationPreparationFingerprint } from "../workflows/generation-preparation-fingerprint";

let database: Database;
const key = new Uint8Array(32).fill(7);
beforeEach(() => {
	database = openInitializedDatabase({ path: ":memory:" });
	initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
});
afterEach(() => database.close());
const post = (path: string, data: GenerationJsonValue) => new Request(`http://localhost/api/connection-settings/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

test("Memory's Decision Model and Semantic Trigger settings reject state token limits below 256", () => {
	const semantic = createSemanticTriggerSettingsModule(database);
	const applyMemory = (decisionStateTokenLimit: number) => applyBoxDecisionSettings(database, "memory", { ...readBoxDecisionSettings(database, "memory"), type: "apply", expectedRevision: readBoxDecisionSettings(database, "memory").revision, decisionStateTokenLimit });
	const applySemantic = (decisionStateTokenLimit: number) => semantic.apply({ ...semantic.get(), type: "apply", expectedRevision: semantic.get().revision, decisionStateTokenLimit });
	for (const apply of [applyMemory, applySemantic]) {
		for (const limit of [1, 255]) expect(() => apply(limit)).toThrow("state token limit");
		expect(apply(256).decisionStateTokenLimit).toBe(256);
	}
});

test("decision presets save independently and require a positive timeout", async () => {
	const app = createConnectionSettingsRoutes(database, { masterKey: new Uint8Array(32).fill(7) });
	const { presets } = await (await app.handle(new Request("http://localhost/api/connection-settings/presets"))).json();
	const decisions = presets.filter((preset: { profile: { apiFormat: string } }) => preset.profile.apiFormat === "system-one");
	expect(decisions.length).toBeGreaterThan(0);
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

test.each([null, 0, -1])("Test Connection rejects a System One timeout of %s before calling the endpoint", async timeoutMs => {
	const result = await testConnection({ profile: { ...blankConnectionProfileDraft, displayName: "Invalid deadline", apiFormat: "system-one", requestUrl: "http://localhost:8000/decision", timeoutMs }, modelId: "clef" }, { fetch: async () => { throw new Error("Unexpected network request"); } });
	expect(result).toMatchObject({ outcome: "failure", kind: "endpoint", message: expect.stringContaining("positive timeout") });
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
	const answers: Record<string, import("../decision-model").DecisionJson> = choices();
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
	const candidate: MemoryRecallCandidateRecord = { identity: "1:1:0:ab", messageId: 1, variantId: 1, claimIndex: 0, writer: false, sourceChanged: false, ...extracted, sourcePosition: 1, semanticSimilarity: 1, semanticRank: 1, recentRank: 1, relevance: null, relevanceScore: null, admission: "request-limit" };
	const { decide } = boxServices(database, async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		expect(tokenxEstimator(JSON.stringify(body.state))).toBeLessThanOrEqual(2000);
		return Response.json({ answers: { "candidate_1:1:0:ab_relevance": { type: "score", score: 2, probabilities: { 0: 0.01, 1: 0.02, 2: 0.9, 3: 0.02 }, provider: "Clef" } }, usage: { cost: 0.01 } });
	}, new AbortController().signal)("memory");
	const result = await judgeMemoryRecallCandidates({ candidates: [candidate], scene: snapshot.activation.scene, relevanceMinimum: 1.5, selection: { model: settings.decisionModel, stateTokenLimit: settings.decisionStateTokenLimit }, decide });
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

test("Semantic Triggers judge the whole scene at a 32,000-token state limit", async () => {
	configureDecisionModels(database, key, "typesafe/jev-1.13", decisionOptions(32_000));
	const scenes: string[][] = [];
	const result = await evaluateSemanticLore({
		entries: [{ enabled: true, semanticTriggers: ["ships arrive"] }],
		messages: [{ content: `oldest ${"a ".repeat(31_980)}` }, { content: `${"b ".repeat(32_000)}newest` }],
		settings: captureSemanticSettings(database),
		fetch: async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			scenes.push(body.state.scene);
			return Response.json({ answers: { trigger_0: { type: "noul", noul: body.state.scene.some((text: string) => text.includes("newest")) ? 0.9 : 0.1 } } });
		},
	});
	expect(result).toEqual({ available: true, threshold: 0.5, matches: [{ trigger: "ships arrive", score: 0.9 }] });
	expect(scenes.length).toBeGreaterThan(1);
	expect(scenes.flat().join("")).toContain("oldest");
	expect(scenes.flat().join("")).toContain("newest");
});

test("an oversized extraction source fails visibly before any request, with no partial record", async () => {
	prepareExtraction();
	const { revision, ...selection } = readBoxDecisionSettings(database, "memory");
	applyBoxDecisionSettings(database, "memory", { type: "apply", expectedRevision: revision, ...selection, decisionStateTokenLimit: 2000 });
	const slot = await digestPassage("Maren kept the key. ".repeat(500), () => async () => { throw new Error("Unexpected network request"); });
	expect(slot?.automatic).toBeUndefined();
	expect(slot?.error?.message).toContain("state token limit");
});

test("a Box's Decision Model selection refuses a chat connection", () => {
	const insert = (format: string) => database.query<{ id: number }, [string, string]>("INSERT INTO connection_profile (display_name, api_format, request_url, model_backend, adapter, timeout_ms) VALUES (?, ?, 'http://localhost:8000/v1/', 'automatic', 'openai-compatible', 15000) RETURNING id").get(format, format)!.id;
	const command = (decisionProfileId: number) => ({ type: "apply" as const, expectedRevision: 0, decisionProfileId, decisionModel: "clef", decisionStateTokenLimit: 2000 });
	expect(() => applyBoxDecisionSettings(database, "memory", command(insert("chat-completions")))).toThrow("System One");
	expect(applyBoxDecisionSettings(database, "memory", command(insert("system-one")))).toMatchObject({ decisionModel: "clef", decisionStateTokenLimit: 2000 });
});

test("creating a Chat never selects a Decision Model as its writing connection", () => {
	configureDecisionModels(database, key, "typesafe/jev-1.13", decisionOptions());
	const conversation = createChat(database);
	expect(readConversationGenerationSettings(database, conversation.id)?.connectionProfileId).toBeNull();
});

test("the preparation fingerprint excludes both Memory and Lore Decision Model credentials", () => {
	const memoryCredential = "memory-decision-credential";
	const loreCredential = "lore-decision-credential";
	const memorySelection = configureDecisionModels(database, key, "jev", { profile: { displayName: "Memory decisions" }, credential: memoryCredential });
	configureDecisionModels(database, key, "clef", { profile: { displayName: "Lore decisions" }, credential: loreCredential });
	applyBoxDecisionSettings(database, "memory", { type: "apply", expectedRevision: readBoxDecisionSettings(database, "memory").revision, ...memorySelection });
	const conversation = createChat(database);
	const snapshot = prepareGenerationInputsSnapshot({ database, conversationId: conversation.id, connection: null, target: { kind: "send", content: "A ship arrives." } });
	expect(snapshot.boxes.some((box) => box.reference === "box:memory")).toBe(true);
	expect(snapshot.lore.sources?.semanticSettings).toMatchObject({ kind: "ready", decision: { credential: loreCredential } });
	const fingerprint = generationPreparationFingerprint(snapshot);
	expect(fingerprint).not.toContain(memoryCredential);
	expect(fingerprint).not.toContain(loreCredential);
});

test.each([{ status: 401, kind: "authentication" }, { status: 403, kind: "authentication" }, { status: 503, kind: "endpoint" }, { status: 0, kind: "endpoint" }])("Test Connection categorizes a Decision Model failure with status $status", async ({ status, kind }) => {
	const app = createConnectionSettingsRoutes(database, { fetch: async () => {
		if (status === 0) throw new TypeError("Connection refused");
		return Response.json({ error: "Unavailable" }, { status });
	} });
	const tested = await app.handle(post("test-connection", { profile: { ...blankConnectionProfileDraft, displayName: "Local", apiFormat: "system-one", requestUrl: "http://localhost:8000/decision", timeoutMs: 15000 }, modelId: "clef" }));
	expect(await tested.json()).toMatchObject({ outcome: "failure", kind });
});
