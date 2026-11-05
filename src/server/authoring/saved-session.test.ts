import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { authoringSessions, authoringStart, type AuthoringMeta } from "../../shared/contract/authoring";
import { blankConnectionProfileDraft } from "../../shared/contract/connection-settings";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { createConnectionSettingsModule } from "../connection-settings";
import { builtInBoxes, loadBoxes } from "../box/registry";
import { openInitializedDatabase } from "../database/database";
import { createAuthoring } from "./index";

type Message = { readonly role: string; readonly content: unknown };
/** @approved A scenario whose input passes the 64 KiB the panel is sent of a tool call's input: five turns of 15,000 characters of prose. */
const longScenario = { cast: ["Writer", "Mara"], seed: "long", turns: Array.from({ length: 5 }, (_, index) => ({ prose: String(index).repeat(15_000) })) };
type Body = Readonly<Record<string, string | number | null>>;
type Delta = { readonly role?: string; readonly content?: string; readonly tool_calls?: readonly { readonly index: number; readonly id: string; readonly type: string; readonly function: { readonly name: string; readonly arguments: string } }[] };

// @approved
//  Runs `act` against an authoring server whose fake model answers each
// request with "Answer <n>.", except "Write CSS.", which it answers by
// calling write_css, and records the messages each request sent.
// `restart` stops the server's sessions and builds a new one on the same
// folder, sweeping it as the app does at startup.
const withAuthoring = async (act: (server: {
	readonly root: string;
	readonly sent: readonly (readonly Message[])[];
	readonly request: (method: string, path: string, body?: Body) => Promise<Response>;
	readonly start: () => Promise<string>;
	readonly prompt: (session: string, text: string) => Promise<string>;
	readonly restart: () => Promise<void>;
	readonly profileId: number;
}) => Promise<void>) => {
	const sent: (readonly Message[])[] = [];
	const model = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(request) {
			const body: { readonly messages: readonly Message[] } = await request.json();
			sent.push(body.messages);
			const asked = body.messages.at(-1)?.content;
			const css = asked === "Write CSS.";
			const scenario = asked === "Run a long scenario.";
			const chunk = (delta: Delta, finish: string | null) => `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 1, model: "coder-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
			const call = { index: 0, id: `call_${sent.length}`, type: "function", function: { name: "write_css", arguments: JSON.stringify({ content: "p { margin: 0; }" }) } };
			const long = { index: 0, id: `call_${sent.length}`, type: "function", function: { name: "run_scenario", arguments: JSON.stringify(longScenario) } };
			const answer = css || scenario ? chunk({ role: "assistant", tool_calls: [css ? call : long] }, null) + chunk({}, "tool_calls") : chunk({ role: "assistant", content: `Answer ${sent.length}.` }, null) + chunk({}, "stop");
			return new Response(`${answer}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		},
	});
	initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.alloc(32, 7).toString("base64") } });
	const database = openInitializedDatabase({ path: ":memory:" });
	const root = mkdtempSync(join(tmpdir(), "ditzy-saved-session-"));
	const folders = { root: join(root, "authoring"), plugins: join(root, "boxes") };
	let authoring = createAuthoring(database, folders);
	try {
		const connections = createConnectionSettingsModule(database);
		connections.createProfile({ expectedRevision: connections.get().revision, profile: { ...blankConnectionProfileDraft, displayName: "Coder", requestUrl: `http://127.0.0.1:${model.port}/v1/`, pinnedModels: ["coder-1"] } });
		const profileId = connections.get().profiles[0]?.id ?? 0;
		const choice = { profileId, model: "coder-1", steps: 40 };
		const request = (method: string, path: string, body?: Body) =>
			authoring.routes.handle(new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json" }, ...body !== undefined && { body: JSON.stringify(body) } }));
		const started = async (response: Response) => {
			const answer: unknown = await response.json();
			if (!Value.Check(authoringStart, answer) || answer.outcome !== "started") throw new Error(`The session did not start: ${JSON.stringify(answer)}`);
			return answer.session;
		};
		await act({
			root: folders.root, sent, request, profileId,
			start: async () => await started(await request("POST", "/api/authoring/sessions", choice)),
			prompt: async (session, text) => await (await request("POST", `/api/authoring/sessions/${session}/prompts`, { text })).text(),
			restart: async () => {
				await authoring.close();
				authoring = createAuthoring(database, folders);
				await authoring.sweep();
			},
		});
	} finally {
		await authoring.close();
		await model.stop(true);
		database.close();
		rmSync(root, { recursive: true, force: true });
	}
};
const open = (request: (method: string, path: string, body?: Body) => Promise<Response>, session: string, profileId: number) =>
	request("POST", `/api/authoring/sessions/${session}/open`, { profileId, model: "coder-1", steps: 40 });
const listed = async (request: (method: string, path: string) => Promise<Response>) => {
	const answer: unknown = await (await request("GET", "/api/authoring/sessions")).json();
	if (!Value.Check(authoringSessions, answer)) throw new Error(`Not a session list: ${JSON.stringify(answer)}`);
	return answer.sessions;
};
const logTypes = async (request: (method: string, path: string) => Promise<Response>, session: string) =>
	(await (await request("GET", `/api/authoring/sessions/${session}/log`)).text()).split("\n").filter((line) => line !== "").map((line) => {
		const entry: { readonly type: string; readonly text?: string; readonly delta?: string } = JSON.parse(line);
		return entry.text ?? entry.delta ?? entry.type;
	});

// @approved
//  A restored agent that lost its conversation would send the second message
// alone; a log that missed the stream would replay nothing; tools not bound
// again to the kept candidate would fail the first tool call after restore.
test("a session survives a restart: the agent resumes from its checkpoint, its tools write the kept candidate, and its log replays both turns", () => withAuthoring(async ({ root, request, start, prompt, restart, sent, profileId }) => {
	const session = await start();
	await prompt(session, "First.");
	await restart();
	expect((await open(request, session, profileId)).status).toBe(200);
	await prompt(session, "Second.");
	expect(sent.at(-1)?.filter(({ role }) => role !== "system").map(({ content }) => content)).toEqual(["First.", "Answer 1.", "Second."]);
	expect(await logTypes(request, session)).toEqual(["First.", "Answer 1.", "end", "Second.", "Answer 2.", "end"]);
	await prompt(session, "Write CSS.");
	const [box] = readdirSync(join(root, session)).filter((name) => name.startsWith("authored-"));
	expect(await Bun.file(join(root, session, box ?? "", "ui.css")).text()).toBe("p { margin: 0; }");
}));

test("closing the panel keeps a session the writer messaged, drops one they never did, and Discard removes its folder and listing", () => withAuthoring(async ({ root, request, start, prompt }) => {
	const session = await start();
	await prompt(session, "First.");
	const untouched = await start();
	await request("POST", `/api/authoring/sessions/${session}/close`);
	await request("POST", `/api/authoring/sessions/${untouched}/close`);
	expect((await listed(request)).map((row) => row.session)).toEqual([session]);
	await request("DELETE", `/api/authoring/sessions/${session}`);
	expect([await listed(request), existsSync(join(root, session))]).toEqual([[], false]);
}));

test("the startup sweep removes only folders that never got their meta.json", () => withAuthoring(async ({ root, request, start, prompt, restart }) => {
	const session = await start();
	await prompt(session, "First.");
	mkdirSync(join(root, "half-made", "authored-0"), { recursive: true });
	await restart();
	expect(readdirSync(root)).toEqual([session]);
	expect((await listed(request)).map((row) => row.session)).toEqual([session]);
}));

// @approved
//  The link to an installed Box is only its id: a session lists its Box as
// installed while a Box with that id is loaded, and a session whose Box is
// gone lists it as not installed, rather than failing or hiding the session.
test("a session lists its Box as installed only while that Box is loaded", () => withAuthoring(async ({ root, request, profileId }) => {
	await loadBoxes([builtInBoxes]);
	const save = (session: string, box: string) => {
		mkdirSync(join(root, session, box), { recursive: true });
		const meta: AuthoringMeta = { box, profileId, model: "coder-1", steps: 40, installed: true, updated: session === loadedSession ? "2026-11-05T02:00:00.000Z" : "2026-11-05T01:00:00.000Z" };
		writeFileSync(join(root, session, "meta.json"), JSON.stringify(meta));
	};
	const loadedSession = crypto.randomUUID();
	const goneSession = crypto.randomUUID();
	save(loadedSession, "mood");
	save(goneSession, "authored-gone");
	expect((await listed(request)).map(({ session, installed }) => [session, installed])).toEqual([[loadedSession, true], [goneSession, false]]);
}));

// @approved
//  The panel's tool event cuts an input past 64 KiB short, so a log that
// kept only that would lose the scenario; the log keeps the whole input.
test("a scenario's whole input is logged, though the tool event the panel sees is cut short", () => withAuthoring(async ({ request, start, prompt }) => {
	const session = await start();
	await prompt(session, "Run a long scenario.");
	const lines: { readonly type: string; readonly truncated?: boolean; readonly input?: unknown }[] = (await (await request("GET", `/api/authoring/sessions/${session}/log`)).text())
		.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
	expect([lines.find(({ type }) => type === "tool")?.truncated, lines.find(({ type }) => type === "scenario-input")?.input]).toEqual([true, longScenario]);
}));
