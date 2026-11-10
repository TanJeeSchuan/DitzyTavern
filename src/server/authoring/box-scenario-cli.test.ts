import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** @approved A copy of the sandboxed Tip Jar fixture, named for its id, and a scenario file beside it. */
const fixture = (scenario: string) => {
	const root = mkdtempSync(join(tmpdir(), "ditzy-box-scenario-"));
	roots.push(root);
	const box = join(root, "tip-jar-sandboxed");
	cpSync(join(import.meta.dir, "../../../e2e/fixtures/boxes/tip-jar-sandboxed"), box, { recursive: true });
	writeFileSync(join(root, "scenario.json"), scenario);
	return { box, scenario: join(root, "scenario.json") };
};
const cli = async (...args: string[]) => {
	const child = Bun.spawn(["bun", join(import.meta.dir, "../../../scripts/box-scenario.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { stdout, stderr, code };
};
const tips = JSON.stringify({ cast: ["Writer", "Mara"], seed: "cli", turns: [{ moves: [{ coins: 1 }] }, { moves: [{ coins: 2 }] }] });

test("a passing scenario prints the run as Creator Mode's run_scenario returns it, and exits 0", async () => {
	const { box, scenario } = fixture(tips);
	const { stdout, code } = await cli(box, scenario);
	const [result]: { ok: boolean; turns: { items: { text: string }[] }[]; state: unknown }[] = JSON.parse(stdout);
	expect([code, result?.ok, result?.turns.map(({ items }) => items.map(({ text }) => text)), result?.state]).toEqual([0, true, [["The tip jar holds 1 coins."], ["The tip jar holds 3 coins."]], 3]);
});

test("a Box that fails its scenario exits 1 with the loader's diagnostic", async () => {
	const { box, scenario } = fixture(tips);
	writeFileSync(join(box, "logic.js"), "export default { records: { initial: 0 } };");
	const { stdout, code } = await cli(box, scenario);
	const [result]: { ok: boolean; diagnostics: string[] }[] = JSON.parse(stdout);
	expect([code, result?.ok]).toEqual([1, false]);
	expect(result?.diagnostics.join(" ")).toContain("did not load");
});

test("a scenario file that isn't a scenario exits 2 naming the bad field, and runs nothing", async () => {
	const { box, scenario } = fixture(JSON.stringify({ cast: [], seed: "cli", turns: [] }));
	const { stdout, stderr, code } = await cli(box, scenario);
	expect([code, stdout]).toEqual([2, ""]);
	expect(stderr).toContain("/cast");
});
