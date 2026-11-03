import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installedBoxes } from "../../shared/contract/box";
import type { ScenarioInput, ScenarioResult } from "../../shared/contract/authoring";
import { openInitializedDatabase } from "../database/database";
import { builtInBoxes, discoverBoxes, loadBoxes, serverBox } from "../box/registry";
import { createCandidate } from "./candidate";
import { installCandidate } from "./install";
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
const call = (tools: Tools, name: string, input: Parameters<Tools[number]["execute"]>[0]) => {
	const tool = tools.find((entry) => entry.name === name);
	if (tool === undefined) throw new Error(`There is no ${name} tool.`);
	return tool.execute(input, { executionId: "call" });
};
/** @approved A candidate written through its tools, as the agent writes one. */
const authored = async (files: { descriptor: object; logic: string; ui?: string }) => {
	const candidate = await createCandidate(scratch());
	const scenarios: ScenarioResult[] = [];
	const tools = authoringTools(candidate, (_, result) => scenarios.push(result));
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
	const tools = authoringTools(candidate, () => {});
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

test("a swipe keeps its turn's seed and Moves, and replaces only that turn's record", async () => {
	const { candidate, scenario } = await authored({
		descriptor: { ...tipJar.descriptor, label: "Mood", moves: undefined, decision: { summary: "s", description: "d", off: "o", context: "c" },
			record: { type: "object", properties: { mood: { type: "string" }, seed: { type: "string" }, preceding: { type: "integer" } }, required: ["mood", "seed", "preceding"] },
			window: { kind: "digest", icon: "drama", size: { width: 20, height: 20 } } },
		logic: `export default {
			records: { initial: [], fold: (moods, { mood }) => [...moods, mood], digest: { window: 1, run: async ({ passage, preceding, seed }, { decide }) => {
				const answers = new Map(await decide({ passage }, { mood: { type: "choice", criteria: { calm: "", tense: "", eerie: "" } } }));
				return { mood: answers.get("mood").choice, seed, preceding: preceding.length };
			} } },
			status: (setup, moods) => moods.join(" then "),
		};`,
	});
	const choice = (mood: string) => ({ mood: { type: "choice" as const, choice: mood, probabilities: { calm: 0, tense: 0, eerie: 0, [mood]: 1 } } });
	const result = await scenario({ cast: ["Ann", "Bard"], seed: "s", turns: [{ prose: "Rain.", decisions: choice("calm") }, { prose: "A knock.", decisions: choice("tense") }], swipes: [{ turn: 0, decisions: choice("eerie") }] });
	const [first, second] = result.turns.map(({ record }) => JSON.stringify(record));
	expect(result).toMatchObject({ ok: true, records: [result.swipes[0]?.record, result.turns[1]?.record], state: ["eerie", "tense"], status: "eerie then tense" });
	expect(JSON.stringify(result.swipes[0]?.record)).toBe(first?.replace('"calm"', '"eerie"'));
	expect(first?.replace('"calm"', '"tense"')).not.toBe(second);
	expect((await scenario({ cast: ["Ann"], seed: "s", turns: [{ prose: "Rain." }] })).diagnostics).toEqual([`The ${candidate.id} Box's records.digest.run threw Error: Turn 0 scripts no answer for the mood question.`]);
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
