import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioInput } from "../../shared/contract/authoring";
import { unversionedBoxIds } from "../box/registry";
import { runScenario } from "./scenario";

const scratch = join(import.meta.dir, "../../../.scratch");
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(join(scratch, "scenario-delegate-"));
cpSync(join(import.meta.dir, "../../../e2e/fixtures/boxes/scene"), join(root, "scene"), { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const run = (input: Omit<ScenarioInput, "cast" | "seed">) => runScenario(join(root, "scene"), "scene", unversionedBoxIds(), { cast: ["Ann", "Bard"], seed: "s", ...input }, new AbortController().signal);

test("a scripted batch becomes the step's record, and a swipe's lands on the swipe's Variant without touching later turns", async () => {
	const result = await run({
		turns: [
			{ prose: "<scene>light the lantern</scene>", delegated: [{ kind: "place", prop: "lantern" }] },
			{ prose: "<scene>set the table</scene>", delegated: [{ kind: "place", prop: "table" }] },
		],
		swipes: [{ turn: 0, prose: "<scene>light a candle</scene>", delegated: [{ kind: "place", prop: "candle" }] }],
	});
	expect(result.diagnostics).toEqual([]);
	expect(result.turns.map(({ record }) => record)).toEqual([{ props: ["lantern"] }, { props: ["lantern", "table"] }]);
	expect(result.swipes.map(({ record }) => record)).toEqual([{ props: ["candle"] }]);
	expect(result.records).toEqual([{ props: ["candle"] }, { props: ["lantern", "table"] }]);
	expect(result.read).toEqual({ view: { props: ["lantern", "table"] }, status: "2 props" });
});

test("prose holding a request without a scripted batch, a batch without a request, and a batch outside the operations each fail the scenario", async () => {
	expect((await run({ turns: [{ prose: "<scene>light the lantern</scene>" }] })).diagnostics).toEqual(["Turn 0's prose holds a <scene> request, so the step needs delegated: the batch the delegate would apply."]);
	expect((await run({ turns: [{ prose: "A quiet hall.", delegated: [] }] })).diagnostics).toEqual(["Turn 0 scripts delegated, but its prose holds no <scene> request."]);
	expect((await run({ turns: [{ prose: "<scene>burn it</scene>", delegated: [{ kind: "burn", prop: "lantern" }] }] })).diagnostics[0]).toStartWith("Turn 0's delegated batch is invalid at /operations/0");
	expect((await run({ turns: [{ prose: "<scene>take the lantern</scene>", delegated: [{ kind: "remove", prop: "lantern" }] }] })).diagnostics).toEqual(["The scene Box's delegate.apply threw Error: There is no lantern on stage."]);
});

test("a swipe with prose of its own scripts its own batch: none for prose without a request, and one for a request of its own", async () => {
	const lantern = { prose: "<scene>light the lantern</scene>", delegated: [{ kind: "place", prop: "lantern" }] };
	const quiet = await run({ turns: [lantern], swipes: [{ turn: 0, prose: "A quiet hall." }] });
	expect([quiet.diagnostics, quiet.swipes.map(({ record }) => record)]).toEqual([[], [undefined]]);
	expect((await run({ turns: [lantern], swipes: [{ turn: 0, prose: "<scene>set the table</scene>" }] })).diagnostics).toEqual(["Turn 0's prose holds a <scene> request, so the step needs delegated: the batch the delegate would apply."]);
});

test("each scenario step starts with the same guest state as a live capture, and its delegate starts separately", async () => {
	const folder = join(root, "counter");
	mkdirSync(folder);
	const descriptor = JSON.parse(await Bun.file(join(root, "scene/descriptor.json")).text());
	await Bun.write(join(folder, "descriptor.json"), JSON.stringify({ ...descriptor, id: "counter" }));
	await Bun.write(join(folder, "ui.js"), "");
	await Bun.write(join(folder, "logic.js"), `let calls = 0; export default {
		records: { initial: { props: [] }, fold: (_, record) => record },
		advance: { run: () => ({ items: [{ text: String(++calls), priority: 1 }] }) },
		delegate: { apply: () => ({ props: [String(++calls)] }) },
		read: () => ({ view: { calls } }),
	};`);
	const result = await runScenario(folder, "counter", unversionedBoxIds(), {
		cast: ["Ann", "Bard"], seed: "s", turns: [
			{ prose: "<scene>first</scene>", delegated: [] },
			{ prose: "<scene>second</scene>", delegated: [] },
		],
	}, new AbortController().signal);
	expect(result.diagnostics).toEqual([]);
	expect(result.turns.map(({ items }) => items.map(({ text }) => text))).toEqual([["1"], ["1"]]);
	expect(result.records).toEqual([{ props: ["1"] }, { props: ["1"] }]);
	expect(result.read).toEqual({ view: { calls: 0 } });
});
