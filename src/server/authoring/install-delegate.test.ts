import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioInput } from "../../shared/contract/authoring";
import type { BoxValue } from "../../shared/contract/box-value";
import { builtInBoxes, loadBoxes } from "../box/registry";
import { createCandidate } from "./candidate";
import { installCandidate } from "./install";
import { authoringTools, checkScenario } from "./tools";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	await loadBoxes([builtInBoxes]);
});
const scratch = () => {
	mkdirSync(".scratch", { recursive: true });
	const root = mkdtempSync(join(".scratch", "install-delegate-"));
	roots.push(root);
	return root;
};

const scene = join(import.meta.dir, "../../../e2e/fixtures/boxes/scene");
const file = (name: string) => readFileSync(join(scene, name), "utf8");
/** @approved The Scene fixture's descriptor.json, as far as these tests rewrite it. */
type Delegate = { readonly tag: string; readonly summary: string; readonly description: string; readonly off: string; readonly operations: { readonly [key: string]: BoxValue | undefined } };
type Json = { readonly [key: string]: BoxValue | Delegate | undefined };
const descriptor: Json & { readonly delegate: Delegate } = JSON.parse(file("descriptor.json"));
const { delegate } = descriptor;
const quiet: ScenarioInput = { cast: ["Ann", "Bard"], seed: "s", turns: [{ prose: "The hall is quiet." }] };

/** @approved The Scene as a candidate, written through its tools with `fields` over its descriptor, checked, and offered for Install. */
const candidateOf = async () => {
	const candidate = await createCandidate(scratch());
	const plugins = scratch();
	const tools = authoringTools(candidate, plugins, { spend: async () => {}, onScenario: () => {} });
	const write = async (name: string, content: string) => await tools.find((tool) => tool.name === name)!.execute({ content }, { executionId: "call", signal: new AbortController().signal }); // @approved The tools always include every write.
	const install = async (fields: Json, logic = file("logic.js")) => {
		await write("write_descriptor", JSON.stringify({ ...descriptor, ...fields }));
		await write("write_logic", logic);
		await write("write_ui", file("ui.js"));
		expect((await candidate.check(() => checkScenario(candidate, plugins, quiet, new AbortController().signal))).ok).toBe(true);
		return await installCandidate(candidate, plugins, [quiet]);
	};
	return { install };
};

test("once a version delegates, Install refuses a later one that renames its tag or drops its delegate", async () => {
	const { install } = await candidateOf();
	expect(await install({})).toMatchObject({ outcome: "installed" });
	const renamed = await install({ delegate: { ...delegate, tag: "stage" } });
	expect(renamed).toMatchObject({ outcome: "incompatible", reason: expect.stringContaining("must keep its delegate and that tag") });
	const dropped = await install({ delegate: undefined, alwaysRender: undefined }, file("logic.js").replace(/\tdelegate: .*\n/, ""));
	expect(dropped).toMatchObject({ outcome: "incompatible", reason: expect.stringContaining("must keep its delegate and that tag") });
	expect(await install({ summary: "Keeps the props on stage." })).toMatchObject({ outcome: "installed" });
});

test("Install refuses a delegate tag another loaded Box takes", async () => {
	const { install } = await candidateOf();
	expect(await install({ delegate: { ...delegate, tag: "sms" } })).toEqual({ outcome: "refused", reason: "The Box did not pass the loader's check.", diagnostics: ["Its tag sms is already the phone Box's."] });
});

test("of two Boxes installing at once with one delegate tag, only one installs", async () => {
	const [first, second] = await Promise.all([candidateOf(), candidateOf()]);
	const outcomes = await Promise.all([first.install({}), second.install({})]);
	expect(outcomes.map(({ outcome }) => outcome).sort()).toEqual(["installed", "refused"]);
});
