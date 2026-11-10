import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { installedBoxes } from "../../shared/contract/box";
import { sandboxedDescriptorFile } from "../../shared/contract/box-sandboxed";
import { assertChecked } from "../../shared/contract/box-descriptor";
import type { ScenarioInput, ScenarioResult } from "../../shared/contract/authoring";
import type { BoxValue } from "../../shared/contract/box-value";
import { sandboxedClient } from "../../client/box-windows/BoxFrame";
import { builtInBoxes, loadBoxes } from "../box/registry";
import { readLatest } from "../box/versions";
import { refusedUpgrade } from "../conversation";
import { createCandidate } from "./candidate";
import { installCandidate } from "./install";
import { stateChanges } from "./scenario";
import { authoringTools, checkScenario } from "./tools";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	await loadBoxes([builtInBoxes]);
});
const scratch = () => {
	mkdirSync(".scratch", { recursive: true });
	const root = mkdtempSync(join(".scratch", "cross-version-"));
	roots.push(root);
	return root;
};

/** @approved A schema as descriptor.json holds it. */
type Schema = Readonly<Record<string, BoxValue>>;
type Files = { readonly descriptor: Schema; readonly logic: string };
const jar = (record: Schema, logic: string): Files => ({
	descriptor: { sdk: 2, label: "Tip Jar", summary: "Collects coins.", role: "system", startsEnabled: false, instructions: "", record,
		moves: { schema: { type: "object", properties: { coins: { type: "integer", minimum: 1 } }, required: ["coins"] }, max: 1, label: "Tip {coins}" },
		window: { icon: "coins", size: { width: 18, height: 12 } } },
	logic: `export default {
		moves: { render: ({ coins }, author) => author + " drops " + coins + "." },
		${logic}
		read: ({ state }) => ({ view: state }),
	};`,
});
const coins = { type: "object", properties: { coins: { type: "integer", minimum: 0 } }, required: ["coins"] };
const v1 = jar(coins, `records: { initial: 0, fold: (total, { coins }) => total + coins },
	advance: { run: async ({ moves }) => ({ items: [], record: { coins: moves.reduce((sum, move) => sum + move.coins, 0) } }) },`);
const tips = (...amounts: number[]): ScenarioInput => ({ cast: ["Ann"], seed: "s", turns: amounts.map((amount) => ({ moves: [{ coins: amount }] })) });

/** @approved A candidate written and checked through its tools, then installed, as a session's agent and writer do; `revise` rewrites it for the next version. */
const installed = async (files: Files, scenario: ScenarioInput) => {
	const candidate = await createCandidate(scratch());
	const plugins = scratch();
	const tools = authoringTools(candidate, plugins, { spend: async () => {}, onScenario: () => {} });
	const write = async (name: string, content: string) => await tools.find((tool) => tool.name === name)!.execute({ content }, { executionId: "call", signal: new AbortController().signal }); // @approved The tools always include every write.
	const revise = async (next: Files) => {
		await write("write_descriptor", JSON.stringify(next.descriptor));
		await write("write_logic", next.logic);
	};
	await revise(files);
	await write("write_ui", "host.render('');");
	const run = (input: ScenarioInput): Promise<ScenarioResult> => candidate.check(() => checkScenario(candidate, plugins, input, new AbortController().signal));
	expect((await run(scenario)).ok).toBe(true);
	expect((await installCandidate(candidate, plugins, [scenario])).outcome).toBe("installed");
	return { candidate, plugins, revise, run };
};

// @approved
//  The translate-on-read pattern: the old field stays as declared but turns
// optional, the new shape is optional and tagged with `v`, and the fold reads
// an untagged record through one adapter.
const translated = jar(
	{ type: "object", properties: { coins: { type: "integer", minimum: 0 }, v: { const: 2 }, cents: { type: "integer", minimum: 0 } } },
	`records: { initial: 0, fold: (total, record) => total + (record.v === undefined ? record.coins * 100 : record.cents) },
	advance: { run: async ({ moves }) => ({ items: [], record: { v: 2, cents: moves.reduce((sum, move) => sum + move.coins, 0) * 100 } }) },`,
);

test("a v2 that keeps v1's field optional and adds a tagged shape passes from, and its adapter folds v1's records beside its own", async () => {
	const { candidate, plugins, revise, run } = await installed(v1, tips(1));
	const latest = await readLatest(join(plugins, candidate.id));
	await revise(translated);
	const result = await run({ ...tips(1, 2, 3), from: { version: "latest", turns: 2 } });
	expect(result).toMatchObject({ ok: true, records: [{ coins: 1 }, { coins: 2 }, { v: 2, cents: 300 }], state: 600 });
	expect(result.upgrade).toEqual({ version: latest!, turns: 2, swipes: 0, changes: [{ path: "", earlier: 3, candidate: 300 }] }); // @approved Installed just above.
});

test("a v2 whose record drops v1's field is refused by from, reading as the writer's Update would, and runs none of its own turns", async () => {
	const { revise, run } = await installed(v1, tips(1));
	await revise(jar({ type: "object", properties: { cents: { type: "integer", minimum: 0 } }, required: ["cents"], additionalProperties: false },
		`records: { initial: 0, fold: (total, { cents }) => total + cents },
		advance: { run: async ({ moves }) => ({ items: [], record: { cents: moves.length * 100 } }) },`));
	const result = await run({ ...tips(1, 2, 3), from: { version: "latest", turns: 2 } });
	expect(result).toMatchObject({ ok: false, diagnostics: [refusedUpgrade("Tip Jar", ["Variant 1 automatic record", "Variant 2 automatic record"])], upgrade: { turns: 2, swipes: 0 } });
	expect(result.turns).toHaveLength(2);
	expect(result.upgrade?.changes).toBeUndefined();
});

test("a same-shape change in meaning passes the Update check and shows in the state diff", async () => {
	const { revise, run } = await installed(v1, tips(1));
	await revise(jar(coins, `records: { initial: 0, fold: (total, { coins }) => coins },
		advance: { run: async ({ state, moves }) => ({ items: [], record: { coins: state + moves.length } }) },`));
	const result = await run({ ...tips(3, 4), from: { version: "latest" } });
	expect(result).toMatchObject({ ok: true, state: 4, upgrade: { turns: 2, changes: [{ path: "", earlier: 7, candidate: 4 }] } });
	expect(await run({ ...tips(3, 4), swipes: [{ turn: 0 }], from: { version: "latest" } })).toMatchObject({ ok: true, upgrade: { turns: 2, swipes: 1 } });
});

test("a from run that stops on the installed version counts only the turns that ran there", async () => {
	const { revise, run } = await installed(v1, tips(1));
	await revise(translated);
	const result = await run({ cast: ["Ann"], seed: "s", turns: [{ moves: [{ coins: 1 }] }, { moves: [{ coins: 1 }, { coins: 1 }] }, {}], from: { version: "latest", turns: 2 } });
	expect(result).toMatchObject({ ok: false, diagnostics: [expect.stringContaining("Turn 1 has 2 Moves")], upgrade: { turns: 1, swipes: 0 } });
});

test("the state diff names each changed place by an escaped JSON pointer, and an object that becomes null as one change", () => {
	expect(stateChanges({ "a/b": 1, "c~d": [1, 2], same: { x: 1 } }, { "a/b": 2, "c~d": [1], same: { x: 1 } })).toEqual([
		{ path: "/a~1b", earlier: 1, candidate: 2 },
		{ path: "/c~0d/1", earlier: 2, candidate: undefined },
	]);
	expect(stateChanges({ a: 1 }, null)).toEqual([{ path: "", earlier: { a: 1 }, candidate: null }]);
	expect(stateChanges([1], { 0: 1 })).toEqual([{ path: "", earlier: [1], candidate: { 0: 1 } }]);
});

/** @approved The Tip Jar with an integer setup, whose `setupError(setup, previous)` returns `refuse`. */
const counted = (refuse: string) => {
	const files = jar(coins, `setupError: (setup, previous) => ${refuse},
		records: { initial: 0, fold: (total, { coins }) => total + coins },
		advance: { run: async ({ moves }) => ({ items: [], record: { coins: moves.length } }) },`);
	return { ...files, descriptor: { ...files.descriptor, setup: { schema: { type: "integer" }, initial: 0 } } };
};

// @approved
//  No Chat saved a default setup, so neither a real Update nor a Chat's
// reads run setupError on it; a scenario that stores none must not either.
test("a from run with no stored setup never asks the candidate's setupError, as a real Update doesn't", async () => {
	const { revise, run } = await installed(counted("undefined"), tips(1));
	await revise(counted("'Saving setup is disabled.'"));
	expect(await run({ ...tips(1, 1), from: { version: "latest", turns: 1 } })).toMatchObject({ ok: true, state: 2 });
});

// @approved
//  A real Update checks a stored setup against itself, so the candidate's
// turns after it must not check it again as a first save from `initial`.
test("a from run keeps the setup the Update check accepted, though a transition-sensitive setupError would refuse it from initial", async () => {
	const { revise, run } = await installed(counted("undefined"), { ...tips(1), setup: 2 });
	await revise(counted("Math.abs(setup - previous) > 1 ? 'too far' : undefined"));
	expect(await run({ ...tips(1, 1), setup: 2, from: { version: "latest", turns: 1 } })).toMatchObject({ ok: true, state: 2 });
});

test("Install skips a saved scenario whose setup the installed version refused, since it left no Chat behind", async () => {
	const { candidate, plugins, revise, run } = await installed(counted("setup > 5 ? 'too big' : undefined"), { ...tips(1), setup: 1 });
	await revise(counted("setup > 3 ? 'too big' : undefined"));
	const revised = { ...tips(1), setup: 1 };
	expect((await run(revised)).ok).toBe(true);
	expect(await installCandidate(candidate, plugins, [{ ...tips(1), setup: 7 }, revised])).toMatchObject({ outcome: "installed" });
});

const packing = (maxLength: number) => {
	const files = mood(["calm", "tense"]);
	return { descriptor: { ...files.descriptor, moves: { schema: { type: "object", properties: { item: { type: "string", maxLength } }, required: ["item"] }, max: 1, label: "Pack {item}" } },
		logic: files.logic.replace("records:", "moves: { render: ({ item }, author) => author + \" packs a \" + item + \".\" },\n\t\trecords:") };
};
const mood = (moods: readonly string[], extra: Schema = {}): Files => ({
	descriptor: { sdk: 2, label: "Mood", summary: "Reads the mood.", role: "system", startsEnabled: false, instructions: "",
		decision: { summary: "s", description: "d", off: "o", context: "c" },
		record: { type: "object", properties: { mood: { anyOf: moods.map((name) => ({ const: name })) }, ...extra }, required: ["mood"], additionalProperties: false },
		window: { kind: "digest", icon: "drama", size: { width: 20, height: 20 } } },
	logic: `export default {
		records: { initial: null, fold: (_, { mood }) => mood, digest: { window: 0, run: async ({ passage }, { decide }) => {
			const answers = new Map(await decide({ passage }, { mood: { type: "choice", criteria: ${JSON.stringify(Object.fromEntries(moods.map((name) => [name, ""])))} } }));
			return { mood: answers.get("mood").choice };
		} } },
		status: (setup, mood) => mood,
	};`,
});
const felt = (name: string, ...others: string[]) => ({ prose: "A passage.", decisions: { mood: { type: "choice" as const, choice: name, probabilities: Object.fromEntries([name, ...others].map((option) => [option, option === name ? 1 : 0])) } } });

test("a digesting v2 that widens a choice passes from and keeps its passage timeline; one that adds an optional field loses it", async () => {
	const { candidate, revise, run } = await installed(mood(["calm", "tense"]), { cast: ["Ann", "Bard"], seed: "s", turns: [felt("calm", "tense")] });
	const timeline = async () => {
		const file: unknown = await Bun.file(join(candidate.folder, "descriptor.json")).json();
		assertChecked(sandboxedDescriptorFile, file, "The candidate's descriptor.json");
		return () => sandboxedClient(candidate.id, file);
	};
	const scenario = { cast: ["Ann", "Bard"], seed: "s", turns: [felt("tense", "calm"), felt("eerie", "calm", "tense")], from: { version: "latest" as const, turns: 1 } };
	await revise(mood(["calm", "tense", "eerie"]));
	expect(await run(scenario)).toMatchObject({ ok: true, status: "eerie" });
	expect(await timeline()).not.toThrow();
	await revise(mood(["calm", "tense", "eerie"], { intensity: { type: "integer" } }));
	expect((await run(scenario)).ok).toBe(true);
	expect(await timeline()).toThrow('A passage timeline cannot edit the optional record field "intensity"');
});

test("Install of a v2 its saved scenarios' data cannot Update to leaves latest alone, and Install as a new Box installs it under a new id", async () => {
	const saved = tips(1);
	const { candidate, plugins, revise, run } = await installed(v1, saved);
	const first = candidate.id;
	const latest = await readLatest(join(plugins, first));
	await revise(jar({ type: "object", properties: { cents: { type: "integer", minimum: 0 } }, required: ["cents"], additionalProperties: false },
		`records: { initial: 0, fold: (total, { cents }) => total + cents },
		advance: { run: async ({ moves }) => ({ items: [], record: { cents: moves.length * 100 } }) },`));
	const revised = tips(2);
	expect((await run(revised)).ok).toBe(true);
	expect(await installCandidate(candidate, plugins, [saved, revised])).toEqual({ outcome: "incompatible", reason: expect.stringContaining("Install it as a new Box"), diagnostics: [
		`Saved scenario 1: ${refusedUpgrade("Tip Jar", ["Variant 1 automatic record"])}`,
		`Saved scenario 2: ${refusedUpgrade("Tip Jar", ["Variant 1 automatic record"])}`,
	] });
	expect(await readLatest(join(plugins, first))).toBe(latest);

	await candidate.renew();
	expect(candidate.id).not.toBe(first);
	expect(await Bun.file(join(candidate.folder, "descriptor.json")).json()).toMatchObject({ id: candidate.id });
	expect((await run(revised)).ok).toBe(true);
	expect(await installCandidate(candidate, plugins, [saved, revised])).toEqual({ outcome: "installed", id: candidate.id, label: "Tip Jar" });
	expect([await readLatest(join(plugins, first)), [...installedBoxes().keys()].slice(-2)]).toEqual([latest, [first, candidate.id]]);
});

// @approved
//  A Send stores its Moves before the digest reads the passage, so a saved
// scenario whose digest fails on latest still leaves its Moves in a Chat.
test("Install checks the Moves a saved scenario left on latest even when its digest failed there", async () => {
	const { candidate, plugins, revise, run } = await installed(packing(20), { cast: ["Ann", "Bard"], seed: "s", turns: [felt("calm", "tense")] });
	await revise(packing(3));
	const revised = { cast: ["Ann", "Bard"], seed: "s", turns: [{ moves: [{ item: "map" }], ...felt("tense", "calm") }] };
	expect((await run(revised)).ok).toBe(true);
	const undigested = { cast: ["Ann", "Bard"], seed: "s", turns: [{ moves: [{ item: "lantern" }], prose: "A passage." }] };
	expect(await installCandidate(candidate, plugins, [undigested, revised])).toMatchObject({ outcome: "incompatible", diagnostics: [`Saved scenario 1: ${refusedUpgrade("Mood", ["Message 1 Moves"])}`] });
});

test("a descriptor write queued behind a new id takes the new id", async () => {
	const candidate = await createCandidate(scratch());
	await candidate.write("descriptor.json", "{}");
	const release = Promise.withResolvers<void>();
	const held = candidate.check(() => release.promise);
	const renewed = candidate.renew();
	const written = candidate.write("descriptor.json", JSON.stringify({ label: "Jar" }));
	release.resolve();
	await Promise.all([held, renewed, written]);
	expect(await Bun.file(join(candidate.folder, "descriptor.json")).json()).toEqual({ label: "Jar", id: candidate.id });
});
