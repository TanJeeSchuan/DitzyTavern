import { staticPlugin } from "@elysiajs/static";
import { join } from "node:path";
import { createContract } from "../../src/server/contract";
import { openInitializedDatabase } from "../../src/server/database/database";
import { seed } from "../../src/server/database/seed";
import { createConnectionSettingsModule } from "../../src/server/connection-settings";
import { createMemorySettingsModule } from "../../src/server/memory/settings";
import { initializeConnectionSecretKey } from "../../src/server/connection-secrets";
import { registerWireFormats } from "../../src/shared/contract/wire-formats";
import type { ModelFetch } from "../../src/server/model-client";

const directory = process.argv[2];
if (!directory) throw new Error("A disposable database directory is required.");
const databasePath = join(directory, "screenshots.sqlite");
const masterKey = new Uint8Array(32).fill(1);
initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(masterKey).toString("base64") } });
registerWireFormats();
seed(databasePath);
const database = openInitializedDatabase({ path: databasePath });

const prose = [
	'"You came back," she said, not looking up from the ledger. The candle beside her had burned down to a stub, and the wax had pooled across three weeks of unpaid accounts. Outside, the rain kept its patient rhythm against the shutters. She turned a page. Then another. He waited by the door, coat dripping, saying nothing at all.',
	'The silence stretched until it became a kind of answer. She closed the ledger at last and looked at him properly, the way one looks at weather that has been threatening all afternoon. "Sit, then. You are ruining the floor." He sat. The chair creaked under him like it remembered his weight from years ago, which perhaps it did. The fire in the grate had gone to embers hours ago, and neither of them moved to feed it. She studied the burn along his sleeve, the soot still caught in the creases of his knuckles, the way he held his left hand a little away from his body as though it belonged to someone else. He let her look. There had been a time when he would have hidden all of it, would have told some story about a lamp knocked over in a careless moment, but that time had burned down along with everything else on the waterfront.',
	'"I heard about the harbor," she said. "Everyone has. Half the town thinks you set the fire yourself, and the other half thinks you should have." She poured two cups of something dark from a kettle that had no business still being warm. "Which half should I believe?" He took the cup. He did not drink. Some questions are better answered with patience than with words.',
].join("\n\n");
const CPS = Number(process.env.CPS ?? 400); // characters per second
const TOKEN = 4; // characters per delta, roughly one token
const tokens = prose.match(new RegExp(`[\\s\\S]{1,${TOKEN}}`, "g"))!;
type Choice = { delta: { content?: string }; finish_reason: "stop" | null };
const sse = (choice: Choice) => `data: ${JSON.stringify({ id: "eyes", choices: [{ index: 0, ...choice }] })}\n\n`;
const fakeFetch: ModelFetch = async (_url, init) => {
	if (!init?.body) return Response.json({ data: [{ id: "deepseek-chat" }] });
	const body = JSON.parse(String(init.body));
	if (body.input !== undefined) return Response.json({
		data: (Array.isArray(body.input) ? body.input : [body.input]).map((_text: string, index: number) => ({ index, embedding: [1, 0, 0] })),
	});
	if (!body.stream) return Response.json({
		id: "screenshot", object: "chat.completion", created: 0, model: "deepseek-chat",
		choices: [{ index: 0, message: { role: "assistant", content: tokens.join("") }, finish_reason: "stop" }],
	});
	const encoder = new TextEncoder();
	return new Response(new ReadableStream({
		async start(controller) {
			const start = performance.now();
			for (const [index, content] of tokens.entries()) {
				controller.enqueue(encoder.encode(sse({ delta: { content }, finish_reason: null })));
				const ahead = start + (index + 1) * 1000 * TOKEN / CPS - performance.now();
				if (ahead > 0) await Bun.sleep(ahead);
			}
			controller.enqueue(encoder.encode(sse({ delta: {}, finish_reason: "stop" }) + "data: [DONE]\n\n"));
			controller.close();
		},
	}), { headers: { "content-type": "text/event-stream" } });
};

const connections = createConnectionSettingsModule(database, { masterKey });
const profile = {
	apiFormat: "chat-completions", adapter: "openai-compatible",
	requestUrl: "https://screenshots.invalid/v1/", modelsUrl: "https://screenshots.invalid/v1/models",
	modelBackend: "automatic", outputTokenRepresentation: "automatic", timeoutMs: 10_000,
} as const;
connections.createProfile({ expectedRevision: 0, profile: { ...profile, displayName: "Screenshot provider", pinnedModels: ["deepseek-chat"] } });
const embeddings = connections.createProfile({
	expectedRevision: connections.get().revision,
	profile: { ...profile, displayName: "Screenshot embeddings", apiFormat: "embeddings", requestUrl: "https://screenshots.invalid/v1/embeddings", pinnedModels: ["screenshot-embedding"] },
}).profiles.find((entry) => entry.apiFormat === "embeddings");
const memory = createMemorySettingsModule(database);
const { revision, ...memorySettings } = memory.get();
memory.apply({ ...memorySettings, expectedRevision: revision, embeddingProfileId: embeddings?.id ?? null, embeddingModel: "screenshot-embedding" });

const app = createContract(database, { masterKey, fetch: fakeFetch }, join(directory, "artifacts"))
	.get("/", () => Bun.file("dist/index.html"))
	.use(await staticPlugin({ assets: "dist", prefix: "/", indexHTML: true, alwaysStatic: true }))
	.listen({ hostname: "127.0.0.1", port: Number(process.env.PORT ?? 0) });

console.log(`CRAWLER_READY ${app.server?.url}`);
