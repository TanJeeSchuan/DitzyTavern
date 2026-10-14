import type { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { openInitializedDatabase } from "../src/server/database/database";
import { seed } from "../src/server/database/seed";
import { createConnectionSettingsModule } from "../src/server/connection-settings";
import { initializeConnectionSecretKey } from "../src/server/connection-secrets";
import { registerWireFormats } from "../src/shared/contract/wire-formats";
import { builtInBoxes, loadBoxes } from "../src/server/box/registry";
import type { ModelFetch } from "../src/server/model-client";
import { toMessages } from "../src/server/model-client/chat-messages";
import { Value } from "@sinclair/typebox/value";
import type { ChatModelCall, DecisionModelCall, ModelCall } from "./protocol";
import {
	chatCompletionCallBody,
	decisionCallBody,
	embeddingsCallBody,
	hasDecisionPassage,
	isChatModelCall,
	type ChatReply,
	type DecisionRule,
	type MemoryClaim,
	type UpdateScenario,
} from "./protocol";

const masterKey = new Uint8Array(32).fill(1);
const directoryRoot = process.env.E2E_ROOT;
if (directoryRoot === undefined) throw new Error("E2E_ROOT must name the worker's temporary directory.");
const pluginFolder = process.env.E2E_BOXES;
if (pluginFolder === undefined) throw new Error("E2E_BOXES must name the worker's plugin folder.");
initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(masterKey).toString("base64") } });
registerWireFormats();

let chatReplies: ChatReply[] = [];
let decisionRules: DecisionRule[] = [];
let memoryClaims: MemoryClaim[] | undefined;
let modelCatalogs: string[][] = [];
let embeddingMatches: string[] = [];
let checkpointTime: number | undefined;
let calls: ModelCall[] = [];
let unscripted: string[] = [];
let held = Promise.withResolvers<void>();
let updateScenario: UpdateScenario = { build: { distribution: "custom", buildNumber: null, revision: null }, replies: [] };
let registryCalls: string[] = [];
let updateDirectory: string;
const fakeRegistryFetch = async (url: string, init?: RequestInit) => {
	registryCalls.push(url);
	if (url.startsWith("https://ghcr.io/token?")) return Response.json({ token: "e2e-public" });
	const reply = updateScenario.replies.shift();
	writeFileSync(join(updateDirectory, "updates.json"), JSON.stringify(updateScenario));
	if (!reply) { unscripted.push(`registry ${url}`); return new Response("Unscripted registry request", { status: 500 }); }
	if ("status" in reply) return new Response("Scripted registry failure", { status: reply.status });
	if (reply.hold) {
		const signal = init?.signal;
		signal?.throwIfAborted();
		const pending = Promise.withResolvers<void>();
		const abort = () => pending.reject(signal?.reason);
		signal?.addEventListener("abort", abort, { once: true });
		held.promise.then(pending.resolve);
		try { await pending.promise; } finally { signal?.removeEventListener("abort", abort); }
	}
	return Response.json({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", annotations: { "io.ditzytavern.distribution": "official", "io.ditzytavern.build-number": String(reply.buildNumber), "org.opencontainers.image.revision": reply.revision } });
};

const refuse = (call: ModelCall) => {
	unscripted.push(`${call.kind} ${call.url}\n${JSON.stringify(call.body, null, 2)}`);
	return Response.json({ error: { message: `Unscripted e2e ${call.kind} call.` } }, { status: 500 });
};

const sse = (chunks: readonly string[], hold: boolean, chunkDelayMs: number, truncate: boolean) => new Response(new ReadableStream({
	async pull(controller) {
		const encoder = new TextEncoder();
		const send = (delta: { content?: string }, finish: string | null) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "e2e", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`));
		for (const [index, content] of chunks.entries()) {
			if (index > 0) await Bun.sleep(chunkDelayMs);
			send({ content }, null);
		}
		if (hold) await held.promise;
		try {
			if (!truncate) {
				send({}, "stop");
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			}
			controller.close();
		} catch {}
	},
}), { headers: { "content-type": "text/event-stream" } });

const completion = (chunks: readonly string[], stream: boolean, hold = false, chunkDelayMs = 0, truncate = false) => stream ? sse(chunks, hold, chunkDelayMs, truncate) : Response.json({
	id: "e2e", object: "chat.completion", created: 0, model: "e2e-model",
	choices: [{ index: 0, message: { role: "assistant", content: chunks.join("") }, finish_reason: "stop" }],
});

const extraction = (call: ChatModelCall) => {
	const [system] = call.body.messages;
	if (memoryClaims === undefined || system === undefined) return refuse(call);
	const prompt = system.content;
	const { source } = JSON.parse(prompt.slice(prompt.indexOf("{", prompt.indexOf("Captured source and reference context:"))));
	const candidates = memoryClaims.filter((memory) => source.content.includes(memory.excerpt)).map(({ excerpt, ...memory }) => ({ ...memory, evidence: [{ messageId: source.messageId, excerpt }] }));
	return completion([JSON.stringify({ candidates })], call.body.stream === true);
};

const chat = async (call: ChatModelCall) => {
	const reply = chatReplies[0];
	if (!reply) return refuse(call);
	if (!reply.repeat) chatReplies.shift();
	if ("chunks" in reply && reply.firstChunkDelayMs) await Bun.sleep(reply.firstChunkDelayMs);
	if ("status" in reply && reply.hold) await held.promise;
	if ("status" in reply) return Response.json({ error: { message: reply.error } }, { status: reply.status });
	return completion(reply.chunks, call.body.stream === true, reply.hold, reply.chunkDelayMs, reply.truncate);
};

const decisions = async (call: DecisionModelCall) => {
	const state = call.body.state;
	const passage = hasDecisionPassage(state) ? JSON.stringify(state.passage) : undefined;
	const rules = Object.entries(call.body.questions).map(([id, question]) => [id, decisionRules.find((rule) =>
		rule.match.every((text) => JSON.stringify(question).includes(text)) && (rule.passage === undefined || (passage !== undefined && passage.includes(rule.passage))))] as const);
	if (rules.some(([, rule]) => !rule)) return refuse(call);
	const failure = rules.find(([, rule]) => rule && "status" in rule)?.[1];
	if (failure && "status" in failure) return Response.json({ error: "Scripted Decision Model failure." }, { status: failure.status });
	if (rules.some(([, rule]) => rule && "answer" in rule && rule.hold)) await held.promise;
	return Response.json({ answers: Object.fromEntries(rules.map(([id, rule]) => [id, rule && "answer" in rule && rule.answer])) });
};

const embed = (text: string) => {
	const buckets = (text.toLowerCase().match(/[a-z']+/g) ?? []).map((word) => [...word].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7) % 64);
	const vector = Array.from({ length: 64 }, (_, slot) => buckets.filter((bucket) => bucket === slot).length);
	const length = Math.hypot(...vector) || 1;
	return vector.map((value) => value / length);
};

const fakeFetch: ModelFetch = async (input, init) => {
	const url = String(input);
	const raw: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
	const headers = Object.fromEntries(new Headers(init?.headers));
	const path = new URL(url).pathname;
	let call: ModelCall;
	if (path.endsWith("/systemone") && Value.Check(decisionCallBody, raw)) {
		call = { kind: "decision", url, headers, body: raw };
	} else if (path.endsWith("/models")) {
		call = { kind: "models", url, headers, body: raw };
	} else if (url.endsWith("/embeddings") && Value.Check(embeddingsCallBody, raw)) {
		call = { kind: "embeddings", url, headers, body: raw };
	} else if (url.endsWith("/chat/completions") && Value.Check(chatCompletionCallBody, raw)) {
		call = { kind: raw.messages[0]?.content.startsWith("Extract durable, attributed story Memories") === true ? "extraction" : "chat", url, headers, body: raw };
	} else {
		call = { kind: "unknown", url, headers, body: raw };
	}
	calls.push(call);
	writeFileSync(join(current!.directory, "calls.json"), JSON.stringify(calls));
	switch (call.kind) {
		case "chat": return chat(call);
		case "extraction": return extraction(call);
		case "decision": return decisions(call);
		case "models": {
			const catalog = modelCatalogs.shift();
			return catalog === undefined ? refuse(call) : Response.json({ data: catalog.map((id) => ({ id })) });
		}
		case "embeddings": {
			const texts: string[] = [call.body.input].flat();
			if (embeddingMatches.length === 0 || texts.some((text) => !embeddingMatches.some((match) => text.includes(match)))) return refuse(call);
			return Response.json({ data: texts.map((text, index) => ({ index, embedding: embed(text) })) });
		}
		case "unknown": return refuse(call);
	}
};

// @approved
//  A test's database, with the Boxes loaded for it: a Box's routes are built
// for one database, so each database the server opens loads them again.
const openDatabase = async (directory: string) => {
	const database = openInitializedDatabase({ path: join(directory, "e2e.sqlite") });
	await loadBoxes([builtInBoxes, pluginFolder], database);
	return database;
};

const provision = (directory: string, database: Database) => {
	seed(join(directory, "e2e.sqlite"));
	const connections = createConnectionSettingsModule(database, { masterKey });
	const profile = {
		apiFormat: "chat-completions", adapter: "openai-compatible",
		requestUrl: "https://e2e.invalid/v1/", modelsUrl: "https://e2e.invalid/v1/models",
		modelBackend: "automatic", outputTokenRepresentation: "automatic", timeoutMs: 10_000,
	} as const;
	connections.createProfile({ expectedRevision: 0, profile: { ...profile, displayName: "E2E provider", pinnedModels: ["e2e-model"] } });
	connections.createProfile({
		expectedRevision: connections.get().revision,
		profile: { ...profile, displayName: "E2E embeddings", apiFormat: "embeddings", requestUrl: "https://e2e.invalid/v1/embeddings", pinnedModels: ["e2e-embedding"] },
	});
	return database;
};

let current: { directory: string; database: Database; app: Awaited<ReturnType<typeof createApp>>["app"]; close: () => Promise<void> } | undefined;

const reset = async () => {
	held.resolve();
	if (current) {
		await current.close();
		current = undefined;
	}
	chatReplies = [];
	decisionRules = [];
	memoryClaims = undefined;
	modelCatalogs = [];
	embeddingMatches = [];
	checkpointTime = undefined;
	calls = [];
	unscripted = [];
	updateScenario = { build: { distribution: "custom", buildNumber: null, revision: null }, replies: [] };
	registryCalls = [];
	held = Promise.withResolvers();
	rmSync(pluginFolder, { recursive: true, force: true });
	const directory = mkdtempSync(join(directoryRoot, "test-"));
	await open(directory, provision(directory, await openDatabase(directory)));
};

const open = async (directory: string, database: Database) => {
	updateDirectory = directory;
	current = { directory, database, ...await createApp({ database, fetch: fakeFetch, updates: { build: updateScenario.build, registryFetch: fakeRegistryFetch }, masterKey, checkpoint: { now: () => checkpointTime ?? Date.now() }, artifactDirectory: join(directory, "artifacts") }) };
};

const resumed = process.env.E2E_RESUME;
if (resumed) {
	if (existsSync(join(resumed, "updates.json"))) updateScenario = JSON.parse(readFileSync(join(resumed, "updates.json"), "utf8"));
	if (existsSync(join(resumed, "calls.json"))) calls = JSON.parse(readFileSync(join(resumed, "calls.json"), "utf8"));
	await open(resumed, await openDatabase(resumed));
} else await reset();

const unsentPlans = async () => {
	const generations = current!.database.query<{ id: number; conversation_id: number }, []>("SELECT id, conversation_id FROM active_generation UNION SELECT id, conversation_id FROM generation_replay").all();
	const sent = calls.filter(isChatModelCall).map((call) => JSON.stringify([call.body.model, call.body.messages]));
	const unsent: string[] = [];
	for (const { id, conversation_id } of generations) {
		const details = await (await current!.app.handle(new Request(`http://localhost/api/conversations/${conversation_id}/generations/${id}/inspection`))).json();
		const captured = JSON.stringify([details.generationSettings.modelId, toMessages({ promptPlan: details.promptPlan }, () => undefined)]);
		if (!sent.includes(captured)) unsent.push(`Generation ${id}: ${captured}`);
	}
	return unsent;
};

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.E2E_PORT ?? 0),
	idleTimeout: 0,
	async fetch(request) {
		switch (new URL(request.url).pathname) {
			case "/__e2e/reset": await reset(); break;
			case "/__e2e/chat": chatReplies.push(...await request.json()); break;
			case "/__e2e/decisions": decisionRules.push(...await request.json()); break;
			case "/__e2e/memories": memoryClaims = [...memoryClaims ?? [], ...await request.json()]; break;
			case "/__e2e/models": modelCatalogs.push(...await request.json()); break;
			case "/__e2e/embeddings": embeddingMatches.push(...await request.json()); break;
			case "/__e2e/checkpoint-clock": checkpointTime = await request.json(); break;
			case "/__e2e/updates": {
				updateScenario = await request.json();
				if (updateScenario.automaticChecks !== undefined) await current!.app.handle(new Request("http://localhost/api/updates/automatic", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: updateScenario.automaticChecks }) }));
				const directory = current!.directory;
				writeFileSync(join(directory, "updates.json"), JSON.stringify(updateScenario));
				await current!.close();
				await open(directory, await openDatabase(directory));
				break;
			}
			case "/__e2e/release": held.resolve(); break;
			case "/__e2e/install-box": {
				const id: string = await request.json();
				cpSync(join(import.meta.dir, "fixtures", "boxes", id), join(pluginFolder, id), { recursive: true });
				break;
			}
			case "/__e2e/directory": return Response.json(current!.directory);
			case "/__e2e/log": return Response.json({ calls, registryCalls, unscripted, unsentPlans: await unsentPlans() });
			case "/__e2e/shutdown": setTimeout(() => { void shutdown(); }, 0); break;
			default: return current!.app.handle(request);
		}
		return Response.json(null);
	},
});

const shutdown = async () => {
	server.stop(true);
	await current!.close();
	process.exit(0);
};
process.once("SIGTERM", () => shutdown());

console.log(`E2E_READY ${server.url}`);
