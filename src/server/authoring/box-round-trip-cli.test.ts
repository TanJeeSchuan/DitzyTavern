import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { authoringMeta, authoringSessions, type ScenarioInput } from "../../shared/contract/authoring";
import { builtInBoxes, loadBoxes } from "../box/registry";
import { openInitializedDatabase } from "../database/database";
import { AUTHORED_ID, createCandidate, loggedScenarios } from "./candidate";
import { createAuthoring } from "./index";
import { installCandidate } from "./install";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	await loadBoxes([builtInBoxes]);
});

// @approved
//  An app folder, whose `data/` the scripts use as the server does, and
// beside it the folder an outside agent works in, holding a copy of the
// sandboxed Tip Jar fixture and scenario files.
const fixture = () => {
	mkdirSync(".scratch", { recursive: true });
	const root = resolve(mkdtempSync(join(".scratch", "box-round-trip-")));
	roots.push(root);
	const app = join(root, "app");
	mkdirSync(app);
	const box = join(root, "agent", "tip-jar");
	cpSync(join(import.meta.dir, "../../../e2e/fixtures/boxes/tip-jar-sandboxed"), box, { recursive: true });
	const scenario = (name: string, input: ScenarioInput) => {
		writeFileSync(join(root, "agent", name), JSON.stringify(input));
		return join(root, "agent", name);
	};
	return { root, app, box, scenario, authoring: join(app, "data", "authoring"), plugins: join(app, "data", "boxes") };
};
const cli = async (cwd: string, script: string, ...args: string[]) => {
	const child = Bun.spawn(["bun", join(import.meta.dir, `../../../scripts/${script}.ts`), ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { stdout, stderr, code, session: stdout.split("\n")[0] ?? "" };
};
const tips = (...coins: number[]): ScenarioInput => ({ cast: ["Writer", "Mara"], seed: "cli", turns: coins.map((amount) => ({ moves: [{ coins: amount }] })) });
const read = async (authoring: string, session: string) => {
	const meta: unknown = await Bun.file(join(authoring, session, "meta.json")).json();
	if (!Value.Check(authoringMeta, meta)) throw new Error("meta.json is not a session's meta");
	const log = await Bun.file(join(authoring, session, "log.ndjson")).text();
	return { meta, log, lines: log.trim().split("\n").map((line): { type: string; result?: { ok: boolean } } => JSON.parse(line)) };
};
/** @approved Installs a saved session's candidate as the panel's Install does, replaying its log's scenarios. */
const install = async (authoring: string, plugins: string, session: string) => {
	const { meta, log } = await read(authoring, session);
	return await installCandidate(await createCandidate(authoring, { session, id: meta.box }), plugins, loggedScenarios(log));
};

test("submit makes a new session without a coding model that list shows, whose log holds each run as the panel streams it, and that Install takes", async () => {
	const { app, box, scenario, authoring, plugins } = fixture();
	const submitted = await cli(app, "box-submit", box, scenario("tips.json", tips(1, 2)));
	expect([submitted.code, submitted.stdout.split("\n")[1]]).toEqual([0, "Open it in Create a Box to install."]);
	const { meta, lines } = await read(authoring, submitted.session);
	expect([AUTHORED_ID.test(meta.box), meta.profileId, meta.model, meta.installed]).toEqual([true, undefined, undefined, false]);
	expect((await Bun.file(join(authoring, submitted.session, meta.box, "descriptor.json")).json()).id).toBe(meta.box);
	expect(lines.map(({ type }) => type)).toEqual(["prompt", "tool", "scenario-input", "tool-end", "scenario"]);
	expect(lines[4]?.result?.ok).toBe(true);

	const listed = await createAuthoring(openInitializedDatabase({ path: ":memory:" }), { root: authoring, plugins }).routes.handle(new Request("http://localhost/api/authoring/sessions"));
	const { sessions } = Value.Parse(authoringSessions, await listed.json());
	expect(sessions.map(({ session, label }) => [session, label])).toEqual([[submitted.session, "Tip Jar"]]);
	expect(await install(authoring, plugins, submitted.session)).toEqual({ outcome: "installed", id: meta.box, label: "Tip Jar" });

	// @approved
	//  `--box` makes a second session on the installed Box's id, whose `from`
	// scenario runs on the version the first installed.
	const next = await cli(app, "box-submit", box, "--box", meta.box, scenario("from.json", { ...tips(1, 2), from: { version: "latest", turns: 1 } }));
	expect(next.code).toBe(0);
	expect(next.session).not.toBe(submitted.session);
	expect((await read(authoring, next.session)).meta.box).toBe(meta.box);
	const out = join(app, "..", "next");
	expect((await cli(app, "box-export", next.session, out)).code).toBe(0);
	expect(await Bun.file(join(out, "AGENTS.md")).text()).toContain(`bun run box:submit '${join(out, meta.box)}' --box ${meta.box} '${join(out, "scenarios")}'/*.json`);
	expect((await install(authoring, plugins, next.session)).outcome).toBe("installed");
});

test("a failing scenario exits 1 and still writes the session, so the writer can open it", async () => {
	const { app, box, scenario, authoring } = fixture();
	writeFileSync(join(box, "logic.js"), "export default { records: { initial: 0 } };");
	const submitted = await cli(app, "box-submit", box, scenario("tips.json", tips(1)));
	expect(submitted.code).toBe(1);
	expect(submitted.stderr).toContain("did not load");
	expect((await read(authoring, submitted.session)).lines.at(-1)?.result?.ok).toBe(false);
});

test("submit exits 2 and writes no session for a folder holding a link, or a --box that isn't a Box installed from Creator Mode", async () => {
	const { root, app, box, scenario, authoring, plugins } = fixture();
	const tipsFile = scenario("tips.json", tips(1));
	mkdirSync(join(plugins, "authored-0000000a"), { recursive: true });
	mkdirSync(join(plugins, "authored-0000000b"), { recursive: true });
	writeFileSync(join(plugins, "authored-0000000b", "latest"), `${"a".repeat(64)}\n`);
	mkdirSync(join(plugins, "authored-0000000c", "versions"), { recursive: true });
	writeFileSync(join(plugins, "authored-0000000c", "latest"), `${"c".repeat(64)}\n`);
	writeFileSync(join(plugins, "authored-0000000c", "versions", "c".repeat(64)), "not a folder");
	const linked = join(root, "linked");
	cpSync(box, linked, { recursive: true });
	symlinkSync(join(root, "agent", "tips.json"), join(linked, "notes.json"));
	const refusals = await Promise.all([
		cli(app, "box-submit", linked, tipsFile),
		cli(app, "box-submit", box, "--box", "authored-0000000a", tipsFile),
		cli(app, "box-submit", box, "--box", "authored-0000000b", tipsFile),
		cli(app, "box-submit", box, "--box", "authored-0000000c", tipsFile),
		cli(app, "box-submit", box, "--box", "../boxes", tipsFile),
	]);
	expect(refusals.map(({ code }) => code)).toEqual([2, 2, 2, 2, 2]);
	expect(refusals[0]?.stderr).toContain("a link");
	expect(existsSync(authoring) ? readdirSync(authoring) : []).toEqual([]);
});

test("export writes the candidate named for its id, each saved scenario once, and AGENTS.md, which box:scenario and box:submit take back", async () => {
	const { root, app, box, scenario, authoring } = fixture();
	const once = scenario("once.json", tips(1));
	const submitted = await cli(app, "box-submit", box, once, once, scenario("twice.json", tips(1, 2)));
	const { meta } = await read(authoring, submitted.session);
	const out = join(root, "out");
	expect((await cli(app, "box-export", submitted.session, out)).code).toBe(0);
	expect(readdirSync(out).sort()).toEqual(["AGENTS.md", "scenarios", meta.box].sort());
	expect(readdirSync(join(out, "scenarios")).sort()).toEqual(["1.json", "2.json"]);
	expect(await Bun.file(join(out, "scenarios", "2.json")).json()).toEqual(tips(1, 2));
	const agents = await Bun.file(join(out, "AGENTS.md")).text();
	expect(agents.startsWith(await Bun.file(join(import.meta.dir, "contract.md")).text())).toBe(true);
	expect(agents).toContain(`bun run box:submit '${join(out, meta.box)}' '${join(out, "scenarios")}'/*.json`);

	const scenarios = [join(out, "scenarios", "1.json"), join(out, "scenarios", "2.json")];
	expect((await cli(app, "box-scenario", join(out, meta.box), ...scenarios)).code).toBe(0);
	expect((await cli(app, "box-submit", join(out, meta.box), ...scenarios)).code).toBe(0);
});

test("export exits 2 for a session id that isn't a UUID, a folder that isn't empty, or one inside the app's data folder, writing nothing", async () => {
	const { root, app, box, scenario, authoring } = fixture();
	const submitted = await cli(app, "box-submit", box, scenario("tips.json", tips(1)));
	const out = join(root, "out");
	mkdirSync(out);
	writeFileSync(join(out, "notes.txt"), "mine");
	const inside = join(authoring, submitted.session, "export");
	const dotted = join(app, "data", "..draft");
	const refusals = await Promise.all([
		cli(app, "box-export", "../app", join(root, "fresh")), cli(app, "box-export", submitted.session, out),
		cli(app, "box-export", submitted.session, inside), cli(app, "box-export", submitted.session, dotted),
	]);
	expect(refusals.map(({ code }) => code)).toEqual([2, 2, 2, 2]);
	expect([existsSync(join(root, "fresh")), readdirSync(out), existsSync(inside), existsSync(dotted)]).toEqual([false, ["notes.txt"], false, false]);
});

// @approved
//  The printed commands are copied into a shell; a folder named with `$`, a
// backtick or a space must reach the scripts as it is, not expand or split.
test("export prints commands that a shell passes the export folder to unchanged, whatever its name holds", async () => {
	const { root, app, box, scenario } = fixture();
	const submitted = await cli(app, "box-submit", box, scenario("tips.json", tips(1)));
	const out = join(root, "out $HOME `x` it's");
	expect((await cli(app, "box-export", submitted.session, out)).code).toBe(0);
	// The command spans to ". It runs each scenario", since the folder name itself holds a backtick.
	const check = (await Bun.file(join(out, "AGENTS.md")).text()).match(/`(bun run box:scenario .+?)`\. It runs/)?.[1] ?? "";
	const echoed = Bun.spawnSync(["sh", "-c", check.replace("bun run box:scenario", "printf '%s\\n'")], { cwd: app }).stdout.toString().trim().split("\n");
	expect(echoed).toEqual([readdirSync(out).filter((name) => name.startsWith("authored-")).map((name) => join(out, name))[0], join(out, "scenarios", "1.json")]);
});
