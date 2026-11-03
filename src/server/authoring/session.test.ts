import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { authoringEvent, authoringStart, type AuthoringEvent } from "../../shared/contract/authoring";
import { blankConnectionProfileDraft } from "../../shared/contract/connection-settings";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { createConnectionSettingsModule } from "../connection-settings";
import { openInitializedDatabase } from "../database/database";
import { createAuthoring, TOOL_CALLS_PER_MESSAGE } from "./index";

test("a model that never stops calling tools is cancelled at the message's budget, and the turn says why", async () => {
	let requests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(request) {
			await request.json();
			requests += 1;
			// @approved A safety stop far past the budget, so a missing budget fails on the count instead of hanging.
			const delta = requests > 200 ? { role: "assistant", content: "Done." } : { role: "assistant", tool_calls: [{ index: 0, id: `call_${requests}`, type: "function", function: { name: "write_css", arguments: JSON.stringify({ content: "p { margin: 0; }" }) } }] };
			const chunk = (body: { readonly delta: typeof delta | Record<string, never>; readonly finish_reason: string | null }) => `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 1, model: "coder-1", choices: [{ index: 0, ...body }] })}\n\n`;
			return new Response(`${chunk({ delta, finish_reason: null })}${chunk({ delta: {}, finish_reason: requests > 200 ? "stop" : "tool_calls" })}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		},
	});
	initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.alloc(32, 7).toString("base64") } });
	const database = openInitializedDatabase({ path: ":memory:" });
	const root = mkdtempSync(join(tmpdir(), "ditzy-authoring-session-"));
	const authoring = createAuthoring(database, { root: join(root, "authoring"), plugins: join(root, "boxes") });
	try {
		const connections = createConnectionSettingsModule(database);
		connections.createProfile({ expectedRevision: connections.get().revision, profile: { ...blankConnectionProfileDraft, displayName: "Coder", requestUrl: `http://127.0.0.1:${server.port}/v1/`, pinnedModels: ["coder-1"] } });
		const profileId = connections.get().profiles[0]?.id ?? 0;
		const post = (path: string, body: Readonly<Record<string, string | number>>) => authoring.routes.handle(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
		const started: unknown = await (await post("/api/authoring/sessions", { profileId, model: "coder-1", contextWindow: 32_000, maxOutputTokens: 2_048 })).json();
		if (!Value.Check(authoringStart, started) || started.outcome !== "started") throw new Error(`The session did not start: ${JSON.stringify(started)}`);
		const lines = (await (await post(`/api/authoring/sessions/${started.session}/prompts`, { text: "Write a Box." })).text()).split("\n").filter((line) => line !== "");
		const events = lines.map((line): AuthoringEvent => {
			const event: unknown = JSON.parse(line);
			if (!Value.Check(authoringEvent, event)) throw new Error(`Not an authoring event: ${line}`);
			return event;
		});
		expect(events.filter((event) => event.type === "tool-end" && !event.isError)).toHaveLength(TOOL_CALLS_PER_MESSAGE);
		expect(events.at(-1)).toEqual({ type: "end", stopReason: "budget", error: `The agent used the ${TOOL_CALLS_PER_MESSAGE} tool calls one message allows, so its turn stopped. Send another message to let it continue.` });
		expect(requests).toBeGreaterThan(TOOL_CALLS_PER_MESSAGE);
		expect(requests).toBeLessThanOrEqual(TOOL_CALLS_PER_MESSAGE + 2);
	} finally {
		await authoring.close();
		await server.stop(true);
		database.close();
		rmSync(root, { recursive: true, force: true });
	}
});
