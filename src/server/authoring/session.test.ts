import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { authoringEvent, authoringStart, CONTINUE_STEPS, type AuthoringEvent, type AuthoringSteps } from "../../shared/contract/authoring";
import { blankConnectionProfileDraft } from "../../shared/contract/connection-settings";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { createConnectionSettingsModule } from "../connection-settings";
import { openInitializedDatabase } from "../database/database";
import { budgetSpent, createAuthoring } from "./index";

/** @approved A fake model's safety stop: past this many requests it answers with text, so a turn with no limit ends instead of looping forever. */
const SAFETY_STOP = 60;

// @approved
//  Runs `act` on one writer message against a fake model that answers every
// request, until its safety stop, with `calls` calls to `tool`. `until`
// reads the turn's events up to the next one of a type; `settle` waits until
// nothing more arrives for a moment, reading what did; `requests` is how many
// requests reached the fake so far.
const withTurn = async (options: { readonly tool?: string; readonly calls?: number; readonly steps: AuthoringSteps }, act: (turn: {
	readonly requests: () => number;
	readonly until: (type: AuthoringEvent["type"]) => Promise<AuthoringEvent>;
	readonly settle: () => Promise<void>;
	readonly events: readonly AuthoringEvent[];
	readonly post: (action: "cancel" | "continue") => Promise<Response>;
	readonly setSteps: (steps: AuthoringSteps) => Promise<Response>;
	readonly close: () => Promise<Response>;
}) => Promise<void>) => {
	let requests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(request) {
			await request.json();
			requests += 1;
			const done = requests > SAFETY_STOP;
			const toolCalls = Array.from({ length: options.calls ?? 1 }, (_, index) => ({ index, id: `call_${requests}_${index}`, type: "function", function: { name: options.tool ?? "write_css", arguments: JSON.stringify({ content: "p { margin: 0; }" }) } }));
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
		const request = (method: string, path: string, body?: Readonly<Record<string, string | number | null>>) =>
			authoring.routes.handle(new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json" }, ...body !== undefined && { body: JSON.stringify(body) } }));
		const started: unknown = await (await request("POST", "/api/authoring/sessions", { profileId, model: "coder-1", contextWindow: 32_000, maxOutputTokens: 2_048, steps: options.steps })).json();
		if (!Value.Check(authoringStart, started) || started.outcome !== "started") throw new Error(`The session did not start: ${JSON.stringify(started)}`);
		const path = `/api/authoring/sessions/${started.session}`;
		const body = (await request("POST", `${path}/prompts`, { text: "Write a Box." })).body;
		if (body === null) throw new Error("The turn has no stream.");
		const reader = body.pipeThrough(new TextDecoderStream()).getReader();
		const events: AuthoringEvent[] = [];
		let buffered = "";
		let pending: ReturnType<typeof reader.read> | null = null;
		const read = async (within?: number) => {
			const chunk = await Promise.race([pending ??= reader.read(), ...within === undefined ? [] : [Bun.sleep(within).then(() => null)]]);
			if (chunk !== null) pending = null;
			return chunk;
		};
		const parsed = () => {
			const end = buffered.indexOf("\n");
			if (end < 0) return undefined;
			const line = buffered.slice(0, end);
			buffered = buffered.slice(end + 1);
			const event: unknown = JSON.parse(line);
			if (!Value.Check(authoringEvent, event)) throw new Error(`Not an authoring event: ${line}`);
			events.push(event);
			return event;
		};
		const until = async (type: AuthoringEvent["type"]) => {
			for (;;) {
				const event = parsed();
				if (event?.type === type) return event;
				if (event !== undefined) continue;
				const chunk = await read();
				if (chunk === null || chunk.done) throw new Error(`The turn ended before a ${type} event, after ${JSON.stringify(events.at(-1))}.`);
				buffered += chunk.value;
			}
		};
		const settle = async () => {
			for (let chunk = await read(150); chunk !== null && !chunk.done; chunk = await read(150)) buffered += chunk.value;
			while (parsed() !== undefined);
		};
		await act({ requests: () => requests, until, settle, events, post: (action) => request("POST", `${path}/${action}`), setSteps: (steps) => request("PUT", `${path}/steps`, { steps }), close: () => request("DELETE", path) });
	} finally {
		await authoring.close();
		await server.stop(true);
		database.close();
		rmSync(root, { recursive: true, force: true });
	}
};
const toolsRan = (events: readonly AuthoringEvent[]) => events.filter((event) => event.type === "tool-end" && !event.isError).length;

// @approved
//  Requests are counted before they leave for the provider, so a model
// calling a tool the agent does not have, which no tool ever counts, pauses
// at the same limit as one calling a real tool.
test.each([["a real tool", "write_css", 40], ["a tool the agent does not have", "no_such_tool", 0]] as const)(
	"a model that never stops calling %s pauses at the message's steps, and nothing more reaches it",
	(_, tool, ran) => withTurn({ tool, steps: 40 }, async ({ requests, until, settle, events }) => {
		expect(await until("paused")).toEqual({ type: "paused", steps: 40 });
		await settle();
		expect([requests(), toolsRan(events)]).toEqual([40, ran]);
	}),
);

test("Continue lets exactly 20 more steps through before the next pause, and Stop ends the turn for its budget", () => withTurn({ steps: 40 }, async ({ requests, until, settle, events, post }) => {
	await until("paused");
	await post("continue");
	expect(await until("paused")).toEqual({ type: "paused", steps: 40 + CONTINUE_STEPS });
	await settle();
	expect([requests(), toolsRan(events)]).toEqual([40 + CONTINUE_STEPS, 40 + CONTINUE_STEPS]);
	await post("cancel");
	expect(await until("end")).toEqual({ type: "end", stopReason: "budget", error: budgetSpent(40 + CONTINUE_STEPS) });
	expect(requests()).toBe(40 + CONTINUE_STEPS);
}));

test("closing a paused session cancels its turn instead of leaving it waiting", () => withTurn({ steps: 40 }, async ({ requests, until, close }) => {
	await until("paused");
	await close();
	expect(await until("end")).toMatchObject({ type: "end" });
	expect(requests()).toBe(40);
}));

test("with no limit a looping model runs until it stops on its own, and nothing pauses", () => withTurn({ steps: null }, async ({ requests, until, events }) => {
	expect(await until("end")).toEqual({ type: "end", stopReason: "end_turn" });
	expect([requests(), toolsRan(events), events.some((event) => event.type === "paused")]).toEqual([SAFETY_STOP + 1, SAFETY_STOP, false]);
}));

test("one response asking for more tool calls than the message's steps pauses at the limit", () => withTurn({ calls: 45, steps: 40 }, async ({ requests, until, settle, events }) => {
	expect(await until("paused")).toEqual({ type: "paused", steps: 40 });
	await settle();
	expect([requests(), toolsRan(events)]).toEqual([1, 40]);
}));

test("steps per message change only between turns: refused while a turn runs or waits, accepted once it ends", () => withTurn({ steps: 40 }, async ({ until, post, setSteps }) => {
	await until("paused");
	expect((await setSteps(100)).status).toBe(409);
	await post("cancel");
	await until("end");
	expect((await setSteps(100)).status).toBe(204);
}));
