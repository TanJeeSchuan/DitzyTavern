import { staticPlugin } from "@elysiajs/static";
import { join } from "node:path";
import { createContract } from "../src/server/contract";
import { openInitializedDatabase } from "../src/server/database/database";
import { seed } from "../src/server/database/seed";
import { createConnectionSettingsModule } from "../src/server/connection-settings";
import { createMemorySettingsModule } from "../src/server/memory/settings";
import { initializeConnectionSecretKey } from "../src/server/connection-secrets";
import { registerWireFormats } from "../src/shared/contract/wire-formats";
import type { ModelFetch } from "../src/server/model-client";

const directory = process.argv[2];
if (!directory) throw new Error("A disposable screenshot directory is required.");
const databasePath = join(directory, "screenshots.sqlite");
const masterKey = new Uint8Array(32).fill(1);
initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(masterKey).toString("base64") } });
registerWireFormats();
seed(databasePath);
const database = openInitializedDatabase({ path: databasePath });

const tokens = ["The door opened. ", "A familiar voice called from the hall."];
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
	return new Response([
		...tokens.map((content) => `data: ${JSON.stringify({ id: "screenshot", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`),
		`data: ${JSON.stringify({ id: "screenshot", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
		"data: [DONE]\n\n",
	].join(""), { headers: { "content-type": "text/event-stream" } });
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
	.listen({ hostname: "127.0.0.1", port: 0 });

console.log(`CRAWLER_READY ${app.server?.url}`);
