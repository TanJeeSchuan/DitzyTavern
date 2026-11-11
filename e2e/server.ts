import { DESCRIBE_INSTRUCTION } from "../src/shared/contract/describe";
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
import { imageLoader } from "../src/server/image";
import { toMessages } from "../src/server/model-client/chat-messages";
import { Value } from "@sinclair/typebox/value";
import type { AuthoringReply, ChatModelCall, DecisionModelCall, ModelCall } from "./protocol";
import {
	authoringCallBody,
	imageCallBody,
	isImageRequest,
	messageText,
	readImageRequestBody,
	type ImageReply,
	describeCallBody,
	type DescribeModelCall,
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
let describeReplies: ChatReply[] = [];
let imageReplies: ImageReply[] = [];
let authoringReplies: AuthoringReply[] = [];
let decisionRules: DecisionRule[] = [];
let memoryClaims: MemoryClaim[] | undefined;
let modelCatalogs: string[][] = [];
let embeddingMatches: string[] = [];
let checkpointTimes: number[] = [];
const checkpointNow = () => checkpointTimes.length > 1 ? checkpointTimes.shift()! : checkpointTimes[0] ?? Date.now();
let calls: ModelCall[] = [];
let unscripted: string[] = [];
let held = Promise.withResolvers<void>();
let updateScenario: UpdateScenario = { build: { distribution: "custom", buildNumber: null, revision: null }, replies: [] };
let registryCalls: string[] = [];
/** @approved Every request whose URL names `sandbox-escape`, which only the escape-probe fixture's guest code requests. */
let probes: string[] = [];
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

const sse = (chunks: readonly string[], hold: boolean, truncate: boolean) => new Response(new ReadableStream({
	async pull(controller) {
		const encoder = new TextEncoder();
		const send = (delta: { content?: string }, finish: string | null) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "e2e", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`));
		for (const content of chunks) send({ content }, null);
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

const completion = (chunks: readonly string[], stream: boolean, hold = false, truncate = false) => stream ? sse(chunks, hold, truncate) : Response.json({
	id: "e2e", object: "chat.completion", created: 0, model: "e2e-model",
	choices: [{ index: 0, message: { role: "assistant", content: chunks.join("") }, finish_reason: "stop" }],
});

const extraction = (call: ChatModelCall) => {
	const [system] = call.body.messages;
	if (memoryClaims === undefined || system === undefined) return refuse(call);
	const prompt = messageText(system);
	const { source } = JSON.parse(prompt.slice(prompt.indexOf("{", prompt.indexOf("Captured source and reference context:"))));
	const candidates = memoryClaims.filter((memory) => source.content.includes(memory.excerpt)).map(({ excerpt, ...memory }) => ({ ...memory, evidence: [{ messageId: source.messageId, excerpt }] }));
	return completion([JSON.stringify({ candidates })], call.body.stream === true);
};

const chat = async (call: ChatModelCall | DescribeModelCall, replies = chatReplies) => {
	const reply = replies[0];
	if (!reply) return refuse(call);
	if (!reply.repeat) replies.shift();
	if ("status" in reply && reply.hold) await held.promise;
	if ("status" in reply) return Response.json({ error: { message: reply.error } }, { status: reply.status });
	return completion(reply.chunks, call.body.stream === true, reply.hold, reply.truncate);
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

// @approved
//  The coding agent's provider: libfx sends real HTTP to this server, never
// through the app's fetch, so its requests arrive here, separate from story
// requests. Each answers with the next scripted reply as Chat Completions
// SSE; a tool call's arguments arrive split across two deltas, as providers
// stream them. An unscripted or malformed request fails the test.
const authoring = async (request: Request) => {
	const raw: unknown = await request.json();
	const body = Value.Check(authoringCallBody, raw) ? raw : undefined;
	const call: ModelCall = body === undefined ? { kind: "unknown", url: request.url, headers: Object.fromEntries(request.headers), body: raw } : { kind: "authoring", url: request.url, headers: Object.fromEntries(request.headers), body };
	calls.push(call);
	writeFileSync(join(current!.directory, "calls.json"), JSON.stringify(calls));
	const reply = authoringReplies.shift();
	if (body === undefined || reply === undefined) return refuse(call);
	type Delta = { role?: "assistant"; content?: string; tool_calls?: { index: number; id?: string; type?: "function"; function: { name?: string; arguments: string } }[] };
	const chunk = (delta: Delta, finish: string | null) => `data: ${JSON.stringify({ id: "e2e", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	const chunks = "text" in reply
		? [chunk({ role: "assistant", content: reply.text }, null), chunk({}, "stop")]
		: [...reply.tools.flatMap(({ name, arguments: input }, index) => {
			const text = JSON.stringify(input);
			const half = Math.floor(text.length / 2);
			return [
				chunk({ role: "assistant", tool_calls: [{ index, id: `call_${calls.length}_${index}`, type: "function", function: { name, arguments: text.slice(0, half) } }] }, null),
				chunk({ tool_calls: [{ index, function: { arguments: text.slice(half) } }] }, null),
			];
		}), chunk({}, "tool_calls")];
	return new Response(`${chunks.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
};

const embed = (text: string) => {
	const buckets = (text.toLowerCase().match(/[a-z']+/g) ?? []).map((word) => [...word].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7) % 64);
	const vector = Array.from({ length: 64 }, (_, slot) => buckets.filter((bucket) => bucket === slot).length);
	const length = Math.hypot(...vector) || 1;
	return vector.map((value) => value / length);
};

const fakeFetch: ModelFetch = async (input, init) => {
	const url = String(input);
	const raw: unknown = isImageRequest(url) ? await readImageRequestBody(url, init) : init?.body ? JSON.parse(String(init.body)) : undefined;
	const headers = Object.fromEntries(new Headers(init?.headers));
	const path = new URL(url).pathname;
	let call: ModelCall;
	if (isImageRequest(url) && Value.Check(imageCallBody, raw)) {
		call = { kind: "image", url, headers, body: raw };
	} else if (path.endsWith("/systemone") && Value.Check(decisionCallBody, raw)) {
		call = { kind: "decision", url, headers, body: raw };
	} else if (path.endsWith("/models")) {
		call = { kind: "models", url, headers, body: raw };
	} else if (url.endsWith("/embeddings") && Value.Check(embeddingsCallBody, raw)) {
		call = { kind: "embeddings", url, headers, body: raw };
	} else if (url.endsWith("/chat/completions") && Value.Check(describeCallBody, raw) && raw.messages[0].content === DESCRIBE_INSTRUCTION) {
		call = { kind: "describe", url, headers, body: raw };
	} else if (url.endsWith("/chat/completions") && Value.Check(chatCompletionCallBody, raw)) {
		call = { kind: raw.messages[0] !== undefined && messageText(raw.messages[0]).startsWith("Extract durable, attributed story Memories") ? "extraction" : "chat", url, headers, body: raw };
	} else {
		call = { kind: "unknown", url, headers, body: raw };
	}
	calls.push(call);
	writeFileSync(join(current!.directory, "calls.json"), JSON.stringify(calls));
	switch (call.kind) {
		case "image": {
			const reply = imageReplies.shift();
			if (reply === undefined) return refuse(call);
			if (reply.hold) await held.promise;
			return "status" in reply ? Response.json({ error: { message: reply.error } }, { status: reply.status }) : Response.json({ data: [{ b64_json: reply.base64 }] });
		}
		case "describe": return chat(call, describeReplies);
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
		modelBackend: "automatic", outputTokenRepresentation: "automatic", systemPlacement: "strict", timeoutMs: 60_000,
	} as const;
	connections.createProfile({ expectedRevision: 0, profile: { ...profile, displayName: "E2E provider", pinnedModels: ["e2e-model"] } });
	connections.createProfile({
		expectedRevision: connections.get().revision,
		profile: { ...profile, displayName: "E2E embeddings", apiFormat: "embeddings", requestUrl: "https://e2e.invalid/v1/embeddings", pinnedModels: ["e2e-embedding"] },
	});
};

let current: { directory: string; database: Database; app: Awaited<ReturnType<typeof createApp>>["app"]; close: () => Promise<void> } | undefined;
let seedImage: Uint8Array | undefined;

const reset = async () => {
	held.resolve();
	if (current) {
		await current.close();
		current = undefined;
	}
	chatReplies = [];
	describeReplies = [];
	imageReplies = [];
	authoringReplies = [];
	decisionRules = [];
	memoryClaims = undefined;
	modelCatalogs = [];
	embeddingMatches = [];
	checkpointTimes = [];
	calls = [];
	unscripted = [];
	updateScenario = { build: { distribution: "custom", buildNumber: null, revision: null }, replies: [] };
	registryCalls = [];
	probes = [];
	held = Promise.withResolvers();
	rmSync(pluginFolder, { recursive: true, force: true });
	const directory = mkdtempSync(join(directoryRoot, "test-"));
	if (seedImage) writeFileSync(join(directory, "e2e.sqlite"), seedImage);
	const database = await openDatabase(directory);
	if (!seedImage) {
		provision(directory, database);
		seedImage = database.serialize();
	}
	await open(directory, database);
};

const open = async (directory: string, database: Database) => {
	updateDirectory = directory;
	current = { directory, database, ...await createApp({ database, fetch: fakeFetch, authoring: { root: join(directory, "authoring"), plugins: pluginFolder }, updates: { build: updateScenario.build, registryFetch: fakeRegistryFetch }, masterKey, checkpoint: { now: checkpointNow }, artifactDirectory: join(directory, "artifacts") }) };
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
		const messages = toMessages({ promptPlan: details.promptPlan }, imageLoader(current!.database)).map(({ role, content }) => ({
			role,
			content: Array.isArray(content) ? content.map((part) => part.type === "file"
				? { type: "image_url", image_url: { url: `data:${part.mediaType};base64,${Buffer.from(part.data).toString("base64")}` } }
				: part) : content,
		}));
		const captured = JSON.stringify([details.modelId, messages]);
		if (!sent.includes(captured)) unsent.push(`Generation ${id}: ${captured}`);
	}
	return unsent;
};

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.E2E_PORT ?? 0),
	idleTimeout: 0,
	async fetch(request) {
		if (request.url.includes("sandbox-escape")) probes.push(request.url);
		switch (new URL(request.url).pathname) {
			case "/__e2e/reset": await reset(); break;
			case "/__e2e/images": imageReplies.push(...await request.json()); break;
			case "/__e2e/describe": describeReplies.push(...await request.json()); break;
			case "/__e2e/chat": chatReplies.push(...await request.json()); break;
			case "/__e2e/authoring": authoringReplies.push(...await request.json()); break;
			case "/__e2e/authoring/chat/completions": return authoring(request);
			case "/__e2e/decisions": decisionRules.push(...await request.json()); break;
			case "/__e2e/memories": memoryClaims = [...memoryClaims ?? [], ...await request.json()]; break;
			case "/__e2e/models": modelCatalogs.push(...await request.json()); break;
			case "/__e2e/embeddings": embeddingMatches.push(...await request.json()); break;
			case "/__e2e/checkpoint-clock": checkpointTimes = await request.json(); break;
			case "/__e2e/updates": {
				updateScenario = await request.json();
				if (updateScenario.automaticChecks !== undefined) {
					const response = await current!.app.handle(new Request("http://localhost/api/updates/automatic", {
						method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: updateScenario.automaticChecks }),
					}));
					if (!response.ok) throw new Error(`Setting automatic update checks failed: ${response.status} ${await response.text()}`);
				}
				const directory = current!.directory;
				writeFileSync(join(directory, "updates.json"), JSON.stringify(updateScenario));
				await current!.close();
				await open(directory, await openDatabase(directory));
				break;
			}
			case "/__e2e/release": held.resolve(); break;
			case "/__e2e/corrupt-secrets": current!.database.query("UPDATE connection_secret SET tag = ?").run(Buffer.alloc(16).toString("base64")); break;
			case "/__e2e/install-box": {
				const id: string = await request.json();
				cpSync(join(import.meta.dir, "fixtures", "boxes", id), join(pluginFolder, id), { recursive: true });
				break;
			}
			case "/__e2e/directory": return Response.json(current!.directory);
			case "/__e2e/log": return Response.json({ calls, registryCalls, unscripted, probes, unsentPlans: await unsentPlans() });
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
