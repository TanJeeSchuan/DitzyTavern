/* eslint-disable ditzy/no-contract-definition-outside-contract -- The globals and the submitted draft are this agent's own fixtures, not wire contracts. */
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Type } from "@sinclair/typebox";
import { createConnectionSettingsModule } from "../connection-settings";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { key, profile } from "../contract/prompt-preset-test-fixtures";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { CODE_AGENT_OUTPUT_BYTES, CODE_AGENT_STEPS, runCodeAgent, type CodeAgentActivity, type CodeAgentCall, type CodeAgentFunction } from "./code-agent";
import { applyBoxDelegateSettings, readBoxDelegateSettings } from "./delegate-settings";
import { DEFAULT_BOX_DELEGATE } from "../../shared/contract/box";
import { QuickJSContext, QuickJSRuntime } from "quickjs-emscripten-core";

// @approved
//  The agent's model, a localhost fake speaking Chat Completions: each
// request takes the next scripted reply, a call to `run` with its code, a
// call to `submit` with its draft, several calls in one response, or plain
// text, and a reply may be held until the test releases it. Each request's
// body is kept, so a test reads the tools it declared and the tool results
// it carried back.
type Scripted = { readonly name: string; readonly arguments: string };
type Reply = { readonly run: string } | { readonly submit: unknown } | { readonly calls: readonly Scripted[] } | { readonly text: string; readonly finish?: string } | { readonly held: Promise<void>; readonly then: Reply };
type Body = { readonly messages: readonly { readonly role: string; readonly content: unknown }[]; readonly tools?: readonly { readonly function?: { readonly name?: string; readonly description?: string } }[] };
const replies: Reply[] = [];
const bodies: Body[] = [];
const activities: CodeAgentActivity[] = [];
type Delta = { readonly role?: "assistant"; readonly content?: string; readonly tool_calls?: readonly { readonly index: number; readonly id: string; readonly type: "function"; readonly function: { readonly name: string; readonly arguments: string } }[] };
const chunk = (delta: Delta, finish: string | null) => `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "stage-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const call = (name: string, arguments_: string): Delta => ({ role: "assistant", tool_calls: [{ index: 0, id: `call_${bodies.length}`, type: "function", function: { name, arguments: arguments_ } }] });
const answer = async (reply: Reply | undefined): Promise<Response> => {
	if (reply === undefined) return new Response("No reply scripted.", { status: 500 });
	if ("held" in reply) {
		await reply.held;
		return await answer(reply.then);
	}
	const chunks = "text" in reply ? [chunk({ role: "assistant", content: reply.text }, null), chunk({}, reply.finish ?? "stop")]
		: "calls" in reply ? [chunk({ role: "assistant", tool_calls: reply.calls.map((tool, index) => ({ index, id: `call_${bodies.length}_${index}`, type: "function" as const, function: { name: tool.name, arguments: tool.arguments } })) }, null), chunk({}, "tool_calls")]
		: "run" in reply ? [chunk(call("run", JSON.stringify({ code: reply.run })), null), chunk({}, "tool_calls")]
		: [chunk(call("submit", JSON.stringify({ draft: reply.submit })), null), chunk({}, "tool_calls")];
	return new Response(`${chunks.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
};
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
	bodies.push(await request.json());
	return await answer(replies.shift());
} });
afterAll(async () => { await server.stop(true); });

const settled = async (condition: () => boolean) => {
	for (let attempt = 0; attempt < 2000 && !condition(); attempt += 1) await Bun.sleep(2);
	if (!condition()) throw new Error("The condition never became true.");
};

const submitSchema = Type.Object({ name: Type.String() }, { additionalProperties: false });
const lookupSchema = Type.Function([Type.Integer()], Type.Object({ doubled: Type.Integer() }, { additionalProperties: false }));
const lookup: CodeAgentFunction = (input) => ({ doubled: Number(input ?? 0) * 2 });
const globals = {
	messages: { description: "The story's messages.", schema: Type.Array(Type.Object({ id: Type.Integer(), text: Type.String() }, { additionalProperties: false })), value: [{ id: 0, text: "Maren waits." }, { id: 1, text: "The lantern is lit." }] },
	answers: { description: "Answers the host already holds.", schema: Type.Object({ open: Type.Boolean() }, { additionalProperties: false }), value: { open: true } },
	lookup: { description: "Doubles a number.", schema: lookupSchema, value: lookup },
};

let database: Database;
beforeEach(() => {
	initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
	database = openObservedDatabase();
	replies.length = 0;
	bodies.length = 0;
	activities.length = 0;
});
afterEach(() => database.close());

/** @approved The default delegate model every code agent runs on, or a model set for one Box alone, pointed at the fake model. */
const chooseModel = (requestUrl = `http://127.0.0.1:${server.port}/v1/`, box: string = DEFAULT_BOX_DELEGATE) => {
	const connections = createConnectionSettingsModule(database, { masterKey: key });
	const displayName = box === DEFAULT_BOX_DELEGATE ? "Stage" : `Stage for ${box}`;
	const profileId = connections.createProfile({ expectedRevision: connections.get().revision, profile: { ...profile, displayName, requestUrl }, credential: "stage-secret" })
		.profiles.find((created) => created.displayName === displayName)!.id; // @approved The profile was just created.
	applyBoxDelegateSettings(database, box, { type: "apply", expectedRevision: readBoxDelegateSettings(database, box).revision, profileId, model: "stage-1" });
};

const run = (over: Partial<CodeAgentCall<typeof submitSchema>> = {}) => runCodeAgent(database, {
	boxId: "drafter", instructions: "Draft the person.", globals, submitSchema,
	verify: (draft) => draft.name === "Maren" ? undefined : "Only Maren.",
	signal: new AbortController().signal, onActivity: (activity) => activities.push(activity), ...over,
});

test("one context lasts the run: a variable set in one call is there in the next, the globals are frozen and their names un-writable, and a call can reach a function global", async () => {
	chooseModel();
	replies.push(
		{ run: 'answers.open ? "open" : "closed"' },
		{ run: 'mark = 3; "set"' },
		{ run: "mark + 1" },
		{ run: "answers.open = false; answers.open" },
		{ run: 'messages = 5; messages.length' },
		{ run: "lookup(21).doubled" },
		{ submit: { name: "Maren" } },
	);
	expect(await run()).toEqual({ name: "Maren" });
	expect(activities.map(({ output }) => output)).toEqual([
		'Returned:\n"open"',
		'Returned:\n"set"',
		"Returned:\n4",
		"Returned:\ntrue",
		"Returned:\n2",
		"Returned:\n42",
	]);
	expect(activities.at(0)?.summary).toBe('answers.open ? "open" : "closed"');
	expect(activities.at(0)?.code).toBe('answers.open ? "open" : "closed"');
	const described = bodies[0]?.tools?.find(({ function: fn }) => fn?.name === "run")?.function?.description ?? "";
	expect(described).toContain("declare const messages: { id: number; text: string }[];");
	expect(described).toContain("declare const lookup: (input: number) => { doubled: number };");
	expect(described).toContain("declare const console: { log(...values: unknown[]): void };");
});

test("what the code logs comes back with its final value, and a guest error is the call's output", async () => {
	chooseModel();
	replies.push({ run: 'console.log("note", { a: 1 }); nope' }, { run: 'console.log("second", 2); 2' }, { submit: { name: "Maren" } });
	expect(await run()).toEqual({ name: "Maren" });
	expect(activities.map(({ output }) => output)).toEqual([
		"Logged:\nnote {\"a\":1}\n\nThe drafter Box's code threw ReferenceError: 'nope' is not defined",
		"Logged:\nsecond 2\n\nReturned:\n2",
	]);
});

test("a huge log line is clipped in the guest, not dropped with the value it hid", async () => {
	chooseModel();
	replies.push({ run: 'console.log("x".repeat(30 * 1000 * 1000)); 1' }, { submit: { name: "Maren" } });
	expect(await run()).toEqual({ name: "Maren" });
	const output = activities.at(0)?.output ?? "";
	expect(output.startsWith("Logged:\nxxxxxxxx")).toBe(true);
	expect(output.endsWith("[Output cut off at 8 KiB; narrow your query]")).toBe(true);
});

test("a million console.log calls are buffered in the guest and stay inside one call", async () => {
	chooseModel();
	replies.push({ run: 'for (let index = 0; index < 1000000; index += 1) console.log("tick"); "done"' }, { submit: { name: "Maren" } });
	expect(await run()).toEqual({ name: "Maren" });
	const output = activities.at(0)?.output ?? "";
	expect(output.startsWith("Logged:\ntick")).toBe(true);
	expect(output.endsWith("[Output cut off at 8 KiB; narrow your query]")).toBe(true);
});

test("output past the limit is cut off at exactly the byte limit, notice inside", async () => {
	chooseModel();
	replies.push({ run: `"${"é".repeat(20 * 1024)}"` }, { submit: { name: "Maren" } });
	expect(await run()).toEqual({ name: "Maren" });
	expect(activities).toHaveLength(1);
	const output = activities.at(0)?.output ?? "";
	expect(Buffer.byteLength(output)).toBe(CODE_AGENT_OUTPUT_BYTES);
	expect(output.endsWith("[Output cut off at 8 KiB; narrow your query]")).toBe(true);
});

test("a runaway allocation fails the run with the heap reason, and an endless loop with the time reason", async () => {
	chooseModel();
	replies.push({ run: "const kept = []; while (true) kept.push(new ArrayBuffer(1 << 20)); 1" });
	await expect(run()).rejects.toThrow("The drafter Box's code ran out of its 128 MiB heap.");
	replies.push({ run: "while (true) {}" });
	const started = performance.now();
	await expect(run()).rejects.toThrow("The drafter Box's code ran past its 2000 ms limit.");
	expect(performance.now() - started).toBeLessThan(10_000);
	expect(activities.at(-1)?.output).toBe("The drafter Box's code ran past its 2000 ms limit.");
});

test("a submit outside the schema or the Box's own check returns a tool error, and the first valid one ends the run", async () => {
	chooseModel();
	replies.push({ submit: { name: 7 } }, { submit: { name: "Bob" } }, { submit: { name: "Maren" } });
	expect(await run()).toEqual({ name: "Maren" });
	const toolResults = (index: number) => JSON.stringify((bodies[index]?.messages ?? []).filter((message) => message.role === "tool"));
	expect(toolResults(1)).toContain("Expected string");
	expect(toolResults(2)).toContain("The draft was refused: Only Maren.");
	expect(bodies).toHaveLength(3);
});

test("an agent that ends without submitting fails the run with the last refusal's reason", async () => {
	chooseModel();
	replies.push({ submit: { name: "Bob" } }, { text: "I could not decide." });
	await expect(run()).rejects.toThrow("The draft was refused: Only Maren.");
});

test(`model requests and tool calls past ${CODE_AGENT_STEPS} steps fail the run`, async () => {
	chooseModel();
	replies.push(...Array.from({ length: 12 }, (_, index) => ({ run: String(index) })));
	await expect(run()).rejects.toThrow(`The agent passed its ${CODE_AGENT_STEPS}-step limit.`);
	expect(bodies).toHaveLength(12);
});

test("a valid submit arriving as the step past the cap fails the run instead of ending it", async () => {
	chooseModel();
	replies.push(
		...Array.from({ length: 11 }, (_, index) => ({ run: String(index) })),
		{ calls: [{ name: "run", arguments: JSON.stringify({ code: "1" }) }, { name: "submit", arguments: JSON.stringify({ draft: { name: "Maren" } }) }] },
	);
	await expect(run()).rejects.toThrow(`The agent passed its ${CODE_AGENT_STEPS}-step limit.`);
	expect(bodies).toHaveLength(12);
});

test("cancelling the signal disposes the run's QuickJS context and runtime", async () => {
	chooseModel();
	const held = Promise.withResolvers<void>();
	replies.push({ run: 'kept = "kept"; "set"' }, { held: held.promise, then: { submit: { name: "Maren" } } });
	const cancelled = new AbortController();
	const contextDispose = spyOn(QuickJSContext.prototype, "dispose");
	const runtimeDispose = spyOn(QuickJSRuntime.prototype, "dispose");
	try {
		const stopping = run({ signal: cancelled.signal });
		await settled(() => bodies.length === 2);
		cancelled.abort(new Error("The writer cancelled the draft."));
		await expect(stopping).rejects.toThrow("The writer cancelled the draft.");
		expect(contextDispose.mock.calls.length).toBe(1);
		expect(runtimeDispose.mock.calls.length).toBe(1);
	} finally {
		held.resolve();
		contextDispose.mockRestore();
		runtimeDispose.mockRestore();
	}
});

test("an onActivity that throws does not mask the failure that already stopped the run", async () => {
	chooseModel();
	replies.push({ run: "while (true) {}" });
	await expect(run({ onActivity: () => {
		throw new Error("The stream closed.");
	} })).rejects.toThrow("The drafter Box's code ran past its 2000 ms limit.");
});

test("a global function refuses an argument that is not JSON, before the host sees it", async () => {
	chooseModel();
	const seen: unknown[] = [];
	const watching: CodeAgentFunction = (input) => {
		seen.push(input);
		return { doubled: Number(input ?? 0) * 2 };
	};
	replies.push({ run: "lookup(10n).doubled" }, { run: "lookup(3).doubled" }, { submit: { name: "Maren" } });
	expect(await run({ globals: { ...globals, lookup: { description: "Doubles a number.", schema: lookupSchema, value: watching } } })).toEqual({ name: "Maren" });
	expect(seen).toEqual([3]);
	expect(activities.map(({ output }) => output)).toEqual([
		"The drafter Box's code threw TypeError: Do not know how to serialize a BigInt",
		"Returned:\n6",
	]);
});

test("an off default delegate refuses the run with what to choose, even beside a model set for the Box itself; a broken one with its reason", async () => {
	chooseModel(undefined, "drafter");
	await expect(run()).rejects.toThrow("No agent model is chosen; choose the Default delegate model in Connections.");
	chooseModel("http://192.168.1.4:8080/v1/");
	await expect(run()).rejects.toThrow("Stage uses HTTP; an agent sends HTTP only to localhost, so use HTTPS.");
	expect(bodies).toHaveLength(0);
});
