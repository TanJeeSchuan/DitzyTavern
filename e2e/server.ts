import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { openInitializedDatabase } from "../src/server/database/database";
import { seed } from "../src/server/database/seed";
import { createConnectionSettingsModule } from "../src/server/connection-settings";
import { createMemorySettingsModule } from "../src/server/memory/settings";
import { initializeConnectionSecretKey } from "../src/server/connection-secrets";
import { registerWireFormats } from "../src/shared/contract/wire-formats";
import type { ModelFetch } from "../src/server/model-client";
import { toMessages } from "../src/server/model-client/chat-messages";
import type { ChatReply, JevRule, MemoryClaim, ModelCall } from "./protocol";

const masterKey = new Uint8Array(32).fill(1);
initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(masterKey).toString("base64") } });
registerWireFormats();

let chatReplies: ChatReply[] = [];
let jevRules: JevRule[] = [];
let memoryClaims: MemoryClaim[] = [];
let calls: ModelCall[] = [];
let unscripted: string[] = [];
let held = Promise.withResolvers<void>();

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

const extraction = (call: ModelCall) => {
	const prompt: string = call.body.messages[0].content;
	const { source } = JSON.parse(prompt.slice(prompt.indexOf("{", prompt.indexOf("Captured source and reference context:"))));
	const candidates = memoryClaims.filter((memory) => source.content.includes(memory.excerpt)).map(({ excerpt, ...memory }) => ({ ...memory, evidence: [{ messageId: source.messageId, excerpt }] }));
	return completion([JSON.stringify({ candidates })], call.body.stream);
};

const chat = async (call: ModelCall) => {
	const reply = chatReplies[0];
	if (!reply) return refuse(call);
	if (!reply.repeat) chatReplies.shift();
	if ("status" in reply && reply.hold) await held.promise;
	if ("status" in reply) return Response.json({ error: { message: reply.error } }, { status: reply.status });
	return completion(reply.chunks, call.body.stream, reply.hold, reply.chunkDelayMs, reply.truncate);
};

const jev = (call: ModelCall) => {
	const rules = Object.entries(call.body.questions).map(([id, question]) => [id, jevRules.find((rule) => rule.match.every((text) => JSON.stringify(question).includes(text)))] as const);
	if (rules.some(([, rule]) => !rule)) return refuse(call);
	const failure = rules.find(([, rule]) => rule && "status" in rule)?.[1];
	if (failure && "status" in failure) return Response.json({ error: "Scripted Jev failure." }, { status: failure.status });
	return Response.json({ answers: Object.fromEntries(rules.map(([id, rule]) => [id, rule && "answer" in rule && rule.answer])) });
};

const embed = (text: string) => {
	const vector = Array<number>(64).fill(0);
	for (const word of text.toLowerCase().match(/[a-z']+/g) ?? []) vector[[...word].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7) % 64] += 1;
	const length = Math.hypot(...vector) || 1;
	return vector.map((value) => value / length);
};

const fakeFetch: ModelFetch = async (input, init) => {
	const url = String(input);
	const body = init?.body ? JSON.parse(String(init.body)) : undefined;
	const kind = url.startsWith("https://api.typesafe.ai/") ? "jev"
		: url.endsWith("/models") ? "models"
		: url.endsWith("/embeddings") ? "embeddings"
		: !url.endsWith("/chat/completions") ? "unknown"
		: body.messages[0]?.content.startsWith("Extract durable, attributed story Memories") ? "extraction" : "chat";
	const call = { kind, url, headers: Object.fromEntries(new Headers(init?.headers)), body };
	calls.push(call);
	writeFileSync(join(current!.directory, "calls.json"), JSON.stringify(calls));
	if (kind === "chat") return chat(call);
	if (kind === "extraction") return extraction(call);
	if (kind === "jev") return jev(call);
	if (kind === "models") return Response.json({ data: [{ id: "e2e-model" }] });
	if (kind === "embeddings") return Response.json({ data: [body.input].flat().map((text: string, index: number) => ({ index, embedding: embed(text) })) });
	return refuse(call);
};

const provision = (databasePath: string) => {
	seed(databasePath);
	const database = openInitializedDatabase({ path: databasePath });
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
	const memory = createMemorySettingsModule(database);
	const { revision, ...memorySettings } = memory.get();
	memory.apply({ ...memorySettings, expectedRevision: revision, enabled: false });
	return database;
};

let current: { directory: string; database: ReturnType<typeof provision>; app: Awaited<ReturnType<typeof createApp>>["app"]; close: () => Promise<void> } | undefined;

const reset = async () => {
	held.resolve();
	if (current) {
		await current.close();
		rmSync(current.directory, { recursive: true, force: true });
	}
	chatReplies = [];
	jevRules = [];
	memoryClaims = [];
	calls = [];
	unscripted = [];
	held = Promise.withResolvers();
	const directory = mkdtempSync(join(tmpdir(), "ditzy-e2e-"));
	await open(directory, provision(join(directory, "e2e.sqlite")));
};

const open = async (directory: string, database: ReturnType<typeof provision>) => {
	current = { directory, database, ...await createApp({ database, fetch: fakeFetch, masterKey, artifactDirectory: join(directory, "artifacts") }) };
};

const resumed = process.env.E2E_RESUME;
if (resumed) {
	if (existsSync(join(resumed, "calls.json"))) calls = JSON.parse(readFileSync(join(resumed, "calls.json"), "utf8"));
	await open(resumed, openInitializedDatabase({ path: join(resumed, "e2e.sqlite") }));
} else await reset();

const unsentPlans = async () => {
	const generations = current!.database.query<{ id: number; conversation_id: number }, []>("SELECT id, conversation_id FROM active_generation UNION SELECT id, conversation_id FROM generation_replay").all();
	const sent = calls.filter((call) => call.kind === "chat").map((call) => JSON.stringify([call.body.model, call.body.messages]));
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
			case "/__e2e/jev": jevRules.push(...await request.json()); break;
			case "/__e2e/memories": memoryClaims.push(...await request.json()); break;
			case "/__e2e/release": held.resolve(); break;
			case "/__e2e/directory": return Response.json(current!.directory);
			case "/__e2e/log": return Response.json({ calls, unscripted, unsentPlans: await unsentPlans() });
			default: return current!.app.handle(request);
		}
		return Response.json(null);
	},
});

const shutdown = async (keepFiles: boolean) => {
	server.stop(true);
	await current!.close();
	if (!keepFiles) rmSync(current!.directory, { recursive: true, force: true });
	process.exit(0);
};
process.once("SIGTERM", () => shutdown(false));
process.once("SIGHUP", () => shutdown(true));

console.log(`E2E_READY ${server.url}`);
