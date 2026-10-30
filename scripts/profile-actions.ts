// @approved
//  Times app actions against a copy of a real database, with every provider
// call answered by a local fake after `--latency` ms. Run it through
// `bun run profile:actions <database>` so Bun's CPU profiler writes a
// Markdown profile beside the report in .scratch/profile. The report lists
// each action's wall time and when each provider call started and ended,
// which shows the remote calls an action waits on in series.
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { registerWireFormats } from "../src/shared/contract/wire-formats";
import { openInitializedDatabase } from "../src/server/database/database";
import { initializeConnectionSecretKey } from "../src/server/connection-secrets";
import { boxFolders, loadBoxes } from "../src/server/box/registry";
import { createContract } from "../src/server/contract";
import { recoverActiveGenerations } from "../src/server/workflows/generation-recovery";
import { sweepOrphanedImages } from "../src/server/image";
import { readMemoryEmbedding } from "../src/boxes/memory/server-settings";
import { observeConversationWrites } from "../src/server/conversation";
import { prepareBoxDigests } from "../src/server/box/digest";
import type { ModelFetch } from "../src/server/model-client";
import { forkConversationBody, generationBody, generationPreviewBody, siblingGenerationBody } from "../src/shared/contract/conversation-schema";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		chat: { type: "string" },
		latency: { type: "string", default: "0" },
		tokens: { type: "string", default: "400" },
		repeat: { type: "string", default: "5" },
		"cold-embeddings": { type: "boolean", default: false },
	},
});
const source = positionals[0];
if (source === undefined) throw new Error("Usage: bun run profile:actions <database> [--chat=id] [--latency=ms] [--tokens=n] [--repeat=n] [--cold-embeddings]");
const latency = Number(values.latency);
const tokens = Number(values.tokens);
const repeat = Number(values.repeat);

const directory = join(process.cwd(), ".scratch", "profile");
const copy = join(directory, "actions.sqlite");
mkdirSync(directory, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) rmSync(copy + suffix, { force: true });
new Database(source, { readonly: true }).run("VACUUM INTO ?", [copy]);

type Call = { kind: string; start: number; end?: number; bytes: number };
let calls: Call[] = [];
let actionStart = 0;
const since = () => performance.now() - actionStart;

registerWireFormats();
initializeConnectionSecretKey();
const timed = <T>(run: () => T): [T, number] => {
	const start = performance.now();
	return [run(), performance.now() - start];
};
const [database, openMs] = timed(() => openInitializedDatabase({ path: copy }));
const boxesStart = performance.now();
await loadBoxes(boxFolders, database);
const boxesMs = performance.now() - boxesStart;
const [, recoveryMs] = timed(() => recoverActiveGenerations(database));
const [, sweepMs] = timed(() => sweepOrphanedImages(database));

// @approved Each timed action then embeds every claim, as after a Memory digest or a Writer's edit.
const coldEmbeddings = () => values["cold-embeddings"] && database.run("DELETE FROM embedding_cache");
const embedding = readMemoryEmbedding(database);
const dimensions = embedding === undefined ? 0 : database.query<{ dims: number }, [string]>(
	"SELECT length(vector) / 4 AS dims FROM embedding_cache WHERE space_key = ? LIMIT 1",
).get(embedding.spaceKey)?.dims ?? 1024;

const vectorOf = (text: string) => {
	const vector = Array.from({ length: dimensions }, () => 0);
	for (let index = 0; index < text.length; index++) vector[(text.charCodeAt(index) * 31 + index) % dimensions]! += 1;
	return vector;
};

// @approved
//  Answers every Decision question with its first or middle criterion, so
// Memory recall keeps its candidates and semantic Lore never fires.
const decisionQuestion = Type.Object({ type: Type.String(), criteria: Type.Optional(Type.Union([Type.Array(Type.Unknown()), Type.Record(Type.String(), Type.Unknown())])) });
const decisionBody = Type.Object({ questions: Type.Record(Type.String(), decisionQuestion) });
const embeddingsBody = Type.Object({ input: Type.Union([Type.String(), Type.Array(Type.String())]) });
const chatBody = Type.Object({ stream: Type.Optional(Type.Boolean()) });
const decisionAnswer = (question: Static<typeof decisionQuestion>) => {
	const keys = Object.keys(question.criteria ?? {});
	const pick = keys[Math.floor(keys.length / 2)] ?? "0";
	const probabilities = Object.fromEntries(keys.map((key) => [key, key === pick ? 1 : 0]));
	if (question.type === "noul") return { type: "noul", noul: 0.1 };
	if (question.type === "score") return { type: "score", score: Number(pick), probabilities, confidence: 1 };
	return { type: "choice", choice: pick, probabilities, confidence: 1 };
};

const stream = (call: Call) => new Response(new ReadableStream({
	async start(controller) {
		const encoder = new TextEncoder();
		for (let index = 0; index < tokens; index++) {
			controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "profile", choices: [{ index: 0, delta: { content: `word${index % 50} ` }, finish_reason: null }] })}\n\n`));
			if (index % 20 === 19) await Bun.sleep(0);
		}
		controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "profile", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
		controller.close();
		call.end = since();
	},
}), { headers: { "content-type": "text/event-stream" } });

const fakeFetch: ModelFetch = async (input, init) => {
	const path = new URL(String(input)).pathname;
	const body: unknown = init?.body ? JSON.parse(String(init.body)) : {};
	const kind = path.endsWith("/systemone") ? "decision" : path.endsWith("/embeddings") ? "embeddings" : path.endsWith("/chat/completions") ? "chat" : path;
	const call: Call = { kind, start: since(), bytes: String(init?.body ?? "").length };
	calls.push(call);
	await Bun.sleep(latency);
	if (kind === "chat" && Value.Parse(chatBody, body).stream === true) return stream(call);
	call.end = since();
	if (kind === "decision") {
		const answers = Object.entries(Value.Parse(decisionBody, body).questions).map(([id, question]) => [id, decisionAnswer(question)]);
		return Response.json({ answers: Object.fromEntries(answers) });
	}
	if (kind === "embeddings") return Response.json({ data: [Value.Parse(embeddingsBody, body).input].flat().map((text, index) => ({ index, embedding: vectorOf(text) })) });
	if (kind === "chat") {
		const choices = [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }];
		return Response.json({ id: "profile", object: "chat.completion", created: 0, model: "profile", choices });
	}
	return Response.json({ error: { message: `No fake for ${path}.` } }, { status: 500 });
};

// @approved
//  Digests are queued as the app queues them but never run: background
// extraction would land inside the timed actions.
observeConversationWrites(database, prepareBoxDigests);
const app = createContract(database, { fetch: fakeFetch }, join(directory, "artifacts"));
const chatId = values.chat === undefined
	? database.query<{ id: number }, []>("SELECT conversation_id AS id FROM messages GROUP BY conversation_id ORDER BY count(*) DESC LIMIT 1").get()?.id
	: Number(values.chat);
if (chatId === undefined) throw new Error("The database has no Chat with Messages.");

const formatting = { timeZone: "UTC", locale: "en-US" };
type RouteBody = Static<typeof generationBody> | Static<typeof siblingGenerationBody> | Static<typeof generationPreviewBody> | Static<typeof forkConversationBody>;
const request = async (method: string, path: string, body?: RouteBody) => {
	const response = await app.handle(new Request(`http://localhost${path}`, {
		method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
	}));
	const text = await response.text();
	if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text.slice(0, 400)}`);
	return { text, parse: <Schema extends TSchema>(schema: Schema) => Value.Parse(schema, JSON.parse(text)) };
};
const revision = async () => (await request("GET", `/api/conversations/${chatId}`)).parse(Type.Object({ revision: Type.Integer() })).revision;
const awaitGeneration = async (accepted: Awaited<ReturnType<typeof request>>) => {
	const { generationId } = accepted.parse(Type.Object({ generationId: Type.String() }));
	return (await request("GET", `/api/conversations/${chatId}/generations/${generationId}/events`)).text.length;
};

type Row = { action: string; ms: number[]; bytes: number; calls: Call[] };
const rows: Row[] = [];
const measure = async (action: string, times: number, run: () => Promise<number>) => {
	const row: Row = { action, ms: [], bytes: 0, calls: [] };
	for (let index = 0; index < times; index++) {
		coldEmbeddings();
		calls = [];
		actionStart = performance.now();
		row.bytes = await run();
		row.ms.push(performance.now() - actionStart);
		row.calls = calls;
	}
	rows.push(row);
};

const history = async () => (await request("GET", `/api/conversations/${chatId}/history`)).text.length;
await measure("Open history page", repeat, history);
await measure("Box window: Memory", repeat, async () => (await request("GET", `/api/conversations/${chatId}/boxes/memory`)).text.length);
await measure("Inspect prompt (Send)", repeat, async () =>
	(await request("POST", `/api/conversations/${chatId}/generations/preview`, { kind: "send", content: "The lantern gutters as the door opens.", ...formatting })).text.length);
await measure("Send to settled", 1, async () => awaitGeneration(await request("POST", `/api/conversations/${chatId}/generations`, {
	kind: "send", expectedRevision: await revision(), content: "The lantern gutters as the door opens.", ...formatting,
})));
const page = (await request("GET", `/api/conversations/${chatId}/history`)).parse(Type.Object({ messages: Type.Array(Type.Object({ id: Type.Integer() })) }));
const latest = page.messages.at(-1);
if (latest === undefined) throw new Error("The Chat has no Messages after Send.");
await measure("Swipe (Sibling) to settled", 1, async () =>
	awaitGeneration(await request("POST", `/api/conversations/${chatId}/messages/${latest.id}/sibling/generations`, { kind: "sibling", ...formatting })));
await measure("Fork through latest", 1, async () => (await request("POST", `/api/conversations/${chatId}/fork`, {
	expectedRevision: await revision(), at: { through: latest.id }, trimVariants: false, name: "Profile fork",
})).text.length);

const median = (values: readonly number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!;
const format = (value: number | undefined) => value === undefined ? "…" : value.toFixed(0);
const counts = database.query<{ messages: number; variants: number }, [number]>(
	"SELECT count(DISTINCT m.id) AS messages, count(v.id) AS variants FROM messages m JOIN message_variant v ON v.message_id = m.id WHERE m.conversation_id = ?",
).get(chatId)!; // @approved An aggregate always answers one row.
const lines = [
	`# Action profile`,
	"",
	[
		`Chat ${chatId} (${counts.messages} Messages, ${counts.variants} Variants)`,
		`provider latency ${latency} ms`,
		...values["cold-embeddings"] ? ["cold embedding cache"] : [],
		`${tokens} streamed tokens`,
		`embedding dimensions ${dimensions}`,
	].join(" · "),
	"",
	`Startup: open and migrate ${format(openMs)} ms, load Boxes ${format(boxesMs)} ms, recover Generations ${format(recoveryMs)} ms, image sweep ${format(sweepMs)} ms.`,
	"",
	"| Action | Median ms | Runs | Response bytes | Provider calls (start→end ms) |",
	"| --- | ---: | ---: | ---: | --- |",
	...rows.map(({ action, ms, bytes, calls }) =>
		`| ${action} | ${format(median(ms))} | ${ms.length} | ${bytes} | ${calls.map((call) => `${call.kind} ${format(call.start)}→${format(call.end)}`).join(", ") || "none"} |`),
];
await Bun.write(join(directory, "report.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
database.close();
