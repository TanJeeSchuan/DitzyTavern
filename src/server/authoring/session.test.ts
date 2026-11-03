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
import { budgetSpent, createAuthoring, PER_MESSAGE } from "./index";

/** @approved Runs one writer message against a fake model that answers every request with `calls` calls to `tool`, and returns the turn's events and how many requests reached the fake. */
const loop = async (tool: string, calls: number) => {
	let requests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(request) {
			await request.json();
			requests += 1;
			// @approved A safety stop far past the budget, so a missing budget fails on the count instead of hanging.
			const done = requests > 200;
			const toolCalls = Array.from({ length: calls }, (_, index) => ({ index, id: `call_${requests}_${index}`, type: "function", function: { name: tool, arguments: JSON.stringify({ content: "p { margin: 0; }" }) } }));
			const delta = done ? { role: "assistant", content: "Done." } : { role: "assistant", tool_calls: toolCalls };
			const chunk = (body: { readonly delta: typeof delta | Record<string, never>; readonly finish_reason: string | null }) => `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 1, model: "coder-1", choices: [{ index: 0, ...body }] })}\n\n`;
			return new Response(`${chunk({ delta, finish_reason: null })}${chunk({ delta: {}, finish_reason: done ? "stop" : "tool_calls" })}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
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
		return { events, requests, ran: events.filter((event) => event.type === "tool-end" && !event.isError).length };
	} finally {
		await authoring.close();
		await server.stop(true);
		database.close();
		rmSync(root, { recursive: true, force: true });
	}
};

// @approved
//  Requests are counted before they leave for the provider, so a model
// calling a tool the agent does not have, which no tool ever counts, stops at
// the same limit as one calling a real tool.
test.each([["a real tool", "write_css", PER_MESSAGE["model requests"]], ["a tool the agent does not have", "no_such_tool", 0]] as const)(
	"a model that never stops calling %s is cancelled at the message's model requests, and the turn says why",
	async (_, tool, ran) => {
		const { events, requests, ran: tools } = await loop(tool, 1);
		expect(requests).toBe(PER_MESSAGE["model requests"]);
		expect(tools).toBe(ran);
		expect(events.at(-1)).toEqual({ type: "end", stopReason: "budget", error: budgetSpent("model requests") });
	},
);

test("one response asking for more tool calls than a message allows runs only as many as it allows", async () => {
	const { events, ran } = await loop("write_css", PER_MESSAGE["tool calls"] + 5);
	expect(ran).toBe(PER_MESSAGE["tool calls"]);
	expect(events.at(-1)).toEqual({ type: "end", stopReason: "budget", error: budgetSpent("tool calls") });
});
