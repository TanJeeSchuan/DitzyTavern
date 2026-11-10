import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFxAgent, memory } from "libfx/node";
import { createCandidate } from "./candidate";
import { authoringTools, fitted, TOOL_RESULT_BYTES } from "./tools";

const root = mkdtempSync(join(tmpdir(), "ditzy-tools-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
/** @approved The tools, bound to a fresh candidate no call here writes or checks. */
const tools = async () => authoringTools(await createCandidate(join(root, "authoring")), join(root, "plugins"), { spend: async () => undefined, onScenario: () => undefined });

// @approved
//  libfx refuses a host tool result past 64 KiB with "Host tool result
// exceeded the configured limit", and the Race's sources together are past
// it, so the agent once saw only that error. The example now comes one file
// at a time, each read through real libfx against a fake model.
test("every built-in example's listing and files reach the agent through libfx", async () => {
	const calls = [{ example: "mood" }, { example: "race" }, ...["descriptor.json", "logic.ts", "logic-engine.ts", "shared.ts", "shared-data.ts", "ui.ts", "ui-markup.ts", "ui.css"].map((file) => ({ example: "race", file }))];
	let request = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(incoming) {
			await incoming.json();
			const call = calls[request++];
			const delta = call === undefined ? { role: "assistant", content: "Read." } : { role: "assistant", tool_calls: [{ index: 0, id: `call_${request}`, type: "function", function: { name: "read_contract", arguments: JSON.stringify(call) } }] };
			const chunk = (body: typeof delta | Record<string, never>, finish: string | null) => `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 1, model: "coder-1", choices: [{ index: 0, delta: body, finish_reason: finish }] })}\n\n`;
			return new Response(`${chunk(delta, null)}${chunk({}, call === undefined ? "stop" : "tool_calls")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		},
	});
	const agent = createFxAgent({
		backend: "wasm", durability: memory(), name: "probe", instructions: "Read the examples.", tools: await tools(), model: "coder-1",
		provider: { name: "fake", baseUrl: `http://127.0.0.1:${server.port}/v1`, models: { "coder-1": { supportsToolUse: true } } },
		credentials: async () => ({ apiKey: "key" }),
	});
	try {
		const ended: { readonly isError: boolean; readonly length: number }[] = [];
		for await (const event of agent.session().prompt("Read every example.")) if (event.type === "tool_end") ended.push({ isError: event.isError, length: (event.content ?? "").length });
		expect(ended.map(({ isError }) => isError)).toEqual(calls.map(() => false));
		expect(ended.every(({ length }) => length > 0)).toBe(true);
	} finally {
		await agent.close();
		await server.stop(true);
	}
}, 30_000);

test("an example's unknown file is refused naming the files it has", async () => {
	const read = (await tools()).find(({ name }) => name === "read_contract")!;
	await expect(read.execute({ example: "race", file: "../server.ts" }, { executionId: "1", signal: new AbortController().signal })).rejects.toThrow("The race example has no file ../server.ts");
});

// @approved
//  A session `box:submit` made starts with no history, so the agent once had
// no way to see the files it was asked to change. A file past libfx's limit
// comes in pieces whose offsets the agent follows.
test("read_file returns a file the agent never wrote, in pieces past libfx's limit", async () => {
	const candidate = await createCandidate(join(root, "authoring"));
	const logic = `// ${"é".repeat(TOOL_RESULT_BYTES)}\nexport default {};\n`;
	await Bun.write(join(candidate.folder, "logic.js"), logic);
	const read = authoringTools(candidate, join(root, "plugins"), { spend: async () => undefined, onScenario: () => undefined }).find(({ name }) => name === "read_file")!;
	const call = (input: { readonly file: string; readonly offset?: number }) => read.execute(input, { executionId: "1", signal: new AbortController().signal }).then(String);
	let joined = "";
	for (let offset: number | undefined = 0; offset !== undefined;) {
		const piece: string = await call({ file: "logic.js", offset });
		expect(Buffer.byteLength(piece)).toBeLessThanOrEqual(TOOL_RESULT_BYTES);
		const next = /\n\[logic\.js continues: call read_file with offset (\d+)\.\]$/.exec(piece);
		joined += next === null ? piece : piece.slice(0, next.index);
		offset = next === null ? undefined : Number(next[1]);
	}
	expect(joined).toBe(logic);
	expect(await call({ file: "ui.js" })).toBe("ui.js is not written yet.");
	await expect(call({ file: "../server.ts" })).rejects.toThrow();
});

test("a result past libfx's limit is cut to fit with a note, and one within it passes untouched", () => {
	const scenario = { records: "é".repeat(TOOL_RESULT_BYTES) };
	const cut = String(fitted(scenario));
	expect([Buffer.byteLength(cut) <= TOOL_RESULT_BYTES, cut.endsWith("Ask for less, such as fewer turns.]")]).toEqual([true, true]);
	expect(fitted({ ok: true })).toEqual({ ok: true });
});
