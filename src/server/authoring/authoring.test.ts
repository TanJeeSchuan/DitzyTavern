import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installedBoxes } from "../../shared/contract/box";
import type { ScenarioInput, ScenarioResult } from "../../shared/contract/authoring";
import { openInitializedDatabase } from "../database/database";
import * as registry from "../box/registry";
import { builtInBoxes, discoverBoxes, loadBoxes, serverBox } from "../box/registry";
import { createCandidate } from "./candidate";
import { installCandidate } from "./install";
import { runScenario } from "./scenario";
import { authoringTools } from "./tools";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scratch = () => {
	const root = mkdtempSync(join(tmpdir(), "ditzy-authoring-"));
	roots.push(root);
	return root;
};

const tipJar = {
	descriptor: { sdk: 2, label: "Tip Jar", summary: "Collects coins.", role: "system", startsEnabled: false, instructions: "",
		record: { type: "object", properties: { coins: { type: "integer", minimum: 0 } }, required: ["coins"] },
		moves: { schema: { type: "object", properties: { coins: { type: "integer", minimum: 1 } }, required: ["coins"] }, max: 1, label: "Tip {coins}" },
		window: { icon: "coins", size: { width: 18, height: 12 } } },
	logic: `export default {
		moves: { render: ({ coins }, author) => author + " drops " + coins + "." },
		records: { initial: 0, fold: (total, { coins }) => total + coins },
		read: ({ state }, { snapshot }) => ({ view: { coins: state, note: snapshot({ scope: "library", key: "note" }) } }),
		advance: { run: async ({ state, moves }) => {
			const coins = moves.reduce((sum, move) => sum + move.coins, 0);
			return { items: [{ text: "The jar holds " + (state + coins) + ".", priority: 0, pinned: true }], record: { coins } };
		} },
	};`,
};

type Tools = ReturnType<typeof authoringTools>;
const call = (tools: Tools, name: string, input: Parameters<Tools[number]["execute"]>[0], signal = new AbortController().signal) => {
	const tool = tools.find((entry) => entry.name === name);
	if (tool === undefined) throw new Error(`There is no ${name} tool.`);
	return tool.execute(input, { executionId: "call", signal });
};
const unbudgeted = { spend: () => {}, onScenario: () => {} };
/** @approved A candidate written through its tools, as the agent writes one. */
const authored = async (files: { descriptor: object; logic: string; ui?: string }) => {
	const candidate = await createCandidate(scratch());
	const scenarios: ScenarioResult[] = [];
	const tools = authoringTools(candidate, { spend: () => {}, onScenario: (_, result) => scenarios.push(result) });
	await call(tools, "write_descriptor", { content: JSON.stringify(files.descriptor) });
	await call(tools, "write_logic", { content: files.logic });
	await call(tools, "write_ui", { content: files.ui ?? "host.render('');" });
	const scenario = async (input: ScenarioInput) => {
		await call(tools, "run_scenario", input);
		const result = scenarios.at(-1);
		if (result === undefined) throw new Error("The scenario reported no result.");
		return result;
	};
	return { candidate, tools, scenario };
};

test("a tool argument naming a path, or a body over its file's cap, is refused and writes nothing", async () => {
	const candidate = await createCandidate(scratch());
	const tools = authoringTools(candidate, unbudgeted);
	const outside = join(dirname(candidate.folder), "escape.js");
	expect(() => call(tools, "write_logic", { content: "export default {};", path: "../escape.js" })).toThrow("The write_logic arguments is invalid");
	expect(() => call(tools, "write_ui", { content: "x".repeat(512 * 1024 + 1) })).toThrow("ui.js may hold at most 512 KiB");
	expect(() => call(tools, "run_scenario", { cast: ["Ann"], seed: "s", turns: [{}], folder: "/" })).toThrow("The run_scenario arguments is invalid");
	expect([existsSync(outside), readdirSync(candidate.folder)]).toEqual([false, []]);
});

test("descriptor.json always carries the candidate's id, whatever id the agent wrote", async () => {
	const { candidate } = await authored({ descriptor: { ...tipJar.descriptor, id: "mood" }, logic: tipJar.logic });
	expect(JSON.parse(await Bun.file(join(candidate.folder, "descriptor.json")).text()).id).toBe(candidate.id);
});

test("descriptor.json's cap holds for the exact text written: deep nesting is not inflated, and the id cannot push it past the cap", async () => {
	const candidate = await createCandidate(scratch());
	const tools = authoringTools(candidate, unbudgeted);
	const nested = `{"deep":${"[".repeat(1_400)}${"]".repeat(1_400)}}`;
	await call(tools, "write_descriptor", { content: nested });
	const written = Bun.file(join(candidate.folder, "descriptor.json"));
	expect(await written.text()).toBe(JSON.stringify({ ...JSON.parse(nested), id: candidate.id }));
	const full = `{"x":"${"a".repeat(64 * 1024 - 8)}"}`;
	expect(Buffer.byteLength(full)).toBe(64 * 1024);
	expect(() => call(tools, "write_descriptor", { content: full })).toThrow("descriptor.json may hold at most 64 KiB");
	expect(await written.text()).toStartWith('{"deep":');
});

test("a write waiting behind a check is dropped once its turn is cancelled", async () => {
	const candidate = await createCandidate(scratch());
	const tools = authoringTools(candidate, unbudgeted);
	const release = Promise.withResolvers<void>();
	const check = candidate.check(() => release.promise);
	const stop = new AbortController();
	const write = call(tools, "write_logic", { content: "export default {};" }, stop.signal);
	stop.abort();
	release.resolve();
	await check;
	await expect(write).rejects.toThrow("aborted");
	expect(readdirSync(candidate.folder)).toEqual([]);
	await candidate.remove();
	expect(existsSync(dirname(candidate.folder))).toBe(false);
});

test("a scenario whose turn was cancelled stops and says so", async () => {
	const { candidate } = await authored(tipJar);
	const stop = new AbortController();
	stop.abort();
	expect(await runScenario(candidate.folder, candidate.id, new Set(), { cast: ["Ann"], seed: "s", turns: [{ moves: [{ coins: 1 }] }] }, stop.signal)).toMatchObject({ ok: false, diagnostics: ["The scenario was cancelled."], turns: [] });
});

test("a candidate the loader would refuse fails run_scenario with the loader's own diagnostic", async () => {
	const { candidate, scenario } = await authored({ descriptor: tipJar.descriptor, logic: tipJar.logic.replace("export default {", "export default { routes: () => null,") });
	const { refused: [refusal] } = await discoverBoxes([dirname(candidate.folder)]);
	expect(refusal?.reason).toContain("declares routes");
	expect(await scenario({ cast: ["Ann"], seed: "s", turns: [{}] })).toMatchObject({ ok: false, diagnostics: [`The candidate did not load: ${refusal?.reason}`], turns: [] });
});

test("a scenario runs each turn's Moves through the Box, folds the records, and answers read's snapshot from its own script", async () => {
	const { candidate, scenario } = await authored(tipJar);
	const turns = [{ moves: [{ coins: 1 }] }, { moves: [{ coins: 2 }] }];
	const note = [{ key: "note", value: "\"kept\"", revision: 1 }];
	const passed = await scenario({ cast: ["Ann", "Bard"], seed: "s", turns, snapshot: [{ query: { scope: "library", key: "note" }, answer: note }] });
	expect(passed).toMatchObject({
		ok: true, diagnostics: [],
		turns: [{ moves: ["Ann drops 1."], items: [{ text: "The jar holds 1." }], record: { coins: 1 } }, { moves: ["Ann drops 2."], items: [{ text: "The jar holds 3." }], record: { coins: 2 } }],
		records: [{ coins: 1 }, { coins: 2 }], state: 3, read: { view: { coins: 3, note } },
	});
	expect(passed.recordBytes).toBe(JSON.stringify([{ coins: 1 }, { coins: 2 }]).length);
	expect((await scenario({ cast: ["Ann"], seed: "s", turns })).diagnostics).toEqual([`The ${candidate.id} Box's read threw Error: The scenario scripts no snapshot answer for {"scope":"library","key":"note"}.`]);
});

const packing = {
	descriptor: { ...tipJar.descriptor, label: "Mood", decision: { summary: "s", description: "d", off: "o", context: "c" },
		moves: { schema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] }, max: 1, label: "Pack {item}" },
		record: { type: "object", properties: { mood: { type: "string" }, seed: { type: "string" }, sawMove: { type: "boolean" } }, required: ["mood", "seed", "sawMove"] },
		window: { kind: "digest", icon: "drama", size: { width: 20, height: 20 } } },
	logic: `export default {
		moves: { render: ({ item }, author) => author + " packs a " + item + "." },
		records: { initial: [], fold: (moods, { mood }) => [...moods, mood], digest: { window: 2, run: async ({ passage, preceding, seed }, { decide }) => {
			const answers = new Map(await decide({ passage }, { mood: { type: "choice", criteria: { calm: "", tense: "", eerie: "" } } }));
			return { mood: answers.get("mood").choice, seed, sawMove: [passage, ...preceding].some(({ content }) => content.includes("packs")) };
		} } },
		advance: { run: async ({ moves }) => ({ items: moves.map(({ item }) => ({ text: "Packed " + item + ".", priority: 0 })) }) },
		status: (setup, moods) => moods.join(" then "),
	};`,
};
const choice = (mood: string) => ({ mood: { type: "choice" as const, choice: mood, probabilities: { calm: 0, tense: 0, eerie: 0, [mood]: 1 } } });

test("a swipe keeps its turn's seed and Moves, and replaces only that turn's record", async () => {
	const { candidate, scenario } = await authored(packing);
	const result = await scenario({
		cast: ["Ann", "Bard"], seed: "s",
		turns: [{ moves: [{ item: "rope" }], prose: "Rain.", decisions: choice("calm") }, { prose: "A knock.", decisions: choice("tense") }],
		swipes: [{ turn: 0, decisions: choice("eerie") }],
	});
	const [first = "", second = ""] = result.turns.map(({ record }) => JSON.stringify(record));
	expect(result.swipes).toEqual([{ moves: ["Ann packs a rope."], items: [{ text: "Packed rope.", priority: 0 }], record: expect.anything() }]);
	expect(result).toMatchObject({ ok: true, records: [result.swipes[0]?.record, result.turns[1]?.record], state: ["eerie", "tense"], status: "eerie then tense" });
	expect(JSON.stringify(result.swipes[0]?.record)).toBe(first.replace('"calm"', '"eerie"'));
	expect(first.replace('"calm"', '"tense"')).not.toBe(second);
	expect((await scenario({ cast: ["Ann"], seed: "s", turns: [{ prose: "Rain." }] })).diagnostics).toEqual([`The ${candidate.id} Box's records.digest.run threw Error: Turn 0 scripts no answer for the mood question.`]);
});

test("a scenario digest reads raw prose as production's does: never the rendered Moves, and no passage without prose", async () => {
	const { scenario } = await authored(packing);
	const result = await scenario({ cast: ["Ann", "Bard"], seed: "s", turns: [{ moves: [{ item: "rope" }], prose: "Rain.", decisions: choice("calm") }, { moves: [{ item: "map" }] }] });
	expect(result.turns.map(({ moves, record }) => [moves, record])).toEqual([[["Ann packs a rope."], expect.objectContaining({ sawMove: false })], [["Ann packs a map."], undefined]]);
	expect(result.records).toHaveLength(1);
});

/** @approved Restores the registry the preload built, freeing whatever a test installed. */
const restored = async (run: () => Promise<void>) => {
	try { await run(); } finally { await loadBoxes([builtInBoxes]); }
};

test("Install refuses an id a folder already uses, and installs nothing", () => restored(async () => {
	const database = openInitializedDatabase({ path: ":memory:" });
	const { candidate } = await authored(tipJar);
	const plugins = scratch();
	mkdirSync(join(plugins, candidate.id));
	expect(await installCandidate(database, candidate, plugins)).toEqual({ outcome: "refused", reason: `A Box folder already uses the id ${candidate.id}.`, diagnostics: [] });
	expect([readdirSync(join(plugins, candidate.id)), installedBoxes().has(candidate.id)]).toEqual([[], false]);
	database.close();
}));

test("Install refuses a target folder created while it validated, and leaves that folder alone", () => restored(async () => {
	const database = openInitializedDatabase({ path: ":memory:" });
	const { candidate } = await authored(tipJar);
	const plugins = scratch();
	const target = join(plugins, candidate.id);
	const check = registry.checkSandboxedFolder;
	const spy = spyOn(registry, "checkSandboxedFolder").mockImplementation(async (...args) => {
		mkdirSync(target);
		return await check(...args);
	});
	try {
		expect(await installCandidate(database, candidate, plugins)).toEqual({ outcome: "refused", reason: `A Box folder already uses the id ${candidate.id}.`, diagnostics: [] });
		expect([spy.mock.calls.length, readdirSync(target), installedBoxes().has(candidate.id)]).toEqual([1, [], false]);
	} finally {
		spy.mockRestore();
		database.close();
	}
}));

test("Install publishes the checked folder with its packages, lock and bundle, and adds the Box beside the loaded ones without reloading them", () => restored(async () => {
	const database = openInitializedDatabase({ path: ":memory:" });
	const { candidate } = await authored({ descriptor: { ...tipJar.descriptor, dependencies: { tally: "1.0.0" } }, logic: `import tally from "tally";\n${tipJar.logic.replace("total + coins", "tally(total, coins)")}` });
	const tally = "var tally = (a, b) => a + b; export { tally as default };";
	mkdirSync(join(candidate.folder, "deps"));
	writeFileSync(join(candidate.folder, "deps", "tally@1.0.0.js"), tally);
	writeFileSync(join(candidate.folder, "deps.lock.json"), JSON.stringify({ "tally@1.0.0": new Bun.CryptoHasher("sha256").update(tally).digest("hex") }));
	const mood = serverBox("mood");
	const plugins = scratch();
	expect(await installCandidate(database, candidate, plugins)).toEqual({ outcome: "installed", id: candidate.id, label: "Tip Jar" });
	expect(readdirSync(join(plugins, candidate.id)).sort()).toEqual(["deps", "deps.lock.json", "descriptor.json", "logic.bundle.js", "logic.js", "ui.js"]);
	expect(readdirSync(dirname(plugins)).some((name) => name.startsWith(".box-install-"))).toBe(false);
	expect(serverBox("mood")).toBe(mood);
	expect(mood?.records?.foldAll?.(null, [{ mood: "calm" }], undefined)).toBe("calm");
	expect(serverBox(candidate.id)?.records?.foldAll?.(0, [{ coins: 2 }, { coins: 3 }], undefined)).toBe(5);
	expect([...installedBoxes().keys()].at(-1)).toBe(candidate.id);
	expect((await installCandidate(database, candidate, plugins)).outcome).toBe("refused");
	database.close();
}));
