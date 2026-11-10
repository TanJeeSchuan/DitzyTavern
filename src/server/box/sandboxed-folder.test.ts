import { afterEach, expect, test } from "bun:test";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { discoverBoxes } from "./registry";
import { replaceFile, SANDBOXED_FOLDER, sandboxedFolder } from "./sandboxed-folder";

const parents: string[] = [];
afterEach(() => { for (const made of parents.splice(0)) rmSync(made, { recursive: true, force: true }); });

const roll = "var roll = (n) => n % 6 + 1; export { roll as default };";
const hash = new Bun.CryptoHasher("sha256").update(roll).digest("hex");
const descriptor = (id: string) => JSON.stringify({
	id, sdk: 2, label: "Dice", summary: "Rolls.", role: "system", startsEnabled: false, instructions: "",
	window: { icon: "dice", size: { width: 18, height: 12 } }, dependencies: { dice: "1.0.0", "@scope/dice": "1.0.0" },
});

// @approved
//  A plugin folder beside an `outside` folder the host owns, which holds a
// writable sentinel and a copy of each pinned package. Every Box would load
// if the loader followed its link, so a refusal is the link check's alone.
const plugins = (boxes: Record<string, (box: string, outside: string) => void>) => {
	const parent = mkdtempSync(join(tmpdir(), "ditzy-links-"));
	parents.push(parent);
	const outside = join(parent, "outside");
	mkdirSync(join(outside, "@scope"), { recursive: true });
	writeFileSync(join(outside, "sentinel.js"), "host file");
	for (const name of ["dice@1.0.0.js", "@scope/dice@1.0.0.js"]) writeFileSync(join(outside, name), roll);
	const root = join(parent, "plugins");
	for (const [id, arrange] of Object.entries(boxes)) {
		const box = join(root, id);
		mkdirSync(box, { recursive: true });
		writeFileSync(join(box, "descriptor.json"), descriptor(id));
		writeFileSync(join(box, "logic.js"), 'import roll from "dice";\nimport other from "@scope/dice";\nexport default { read: () => ({ view: roll(1) + other(1) }) };');
		writeFileSync(join(box, "ui.js"), "host.render('');");
		writeFileSync(join(box, "deps.lock.json"), JSON.stringify({ "@scope/dice@1.0.0": hash, "dice@1.0.0": hash }));
		arrange(box, outside);
	}
	return { root, outside };
};

test("a sandboxed Box whose folder holds a link anywhere is refused before the loader reads or writes through it", async () => {
	const own = (box: string) => {
		mkdirSync(join(box, "deps", "@scope"), { recursive: true });
		for (const name of ["dice@1.0.0.js", "@scope/dice@1.0.0.js"]) writeFileSync(join(box, "deps", name), roll);
	};
	const { root, outside } = plugins({
		plain: own,
		"linked-bundle": (box, host) => { own(box); symlinkSync(join(host, "sentinel.js"), join(box, "logic.bundle.js")); },
		"linked-deps": (box, host) => symlinkSync(host, join(box, "deps")),
		"linked-scope": (box, host) => { own(box); rmSync(join(box, "deps", "@scope"), { recursive: true }); symlinkSync(join(host, "@scope"), join(box, "deps", "@scope")); },
		"hard-linked": (box, host) => { own(box); rmSync(join(box, "deps", "dice@1.0.0.js")); linkSync(join(host, "dice@1.0.0.js"), join(box, "deps", "dice@1.0.0.js")); },
	});
	const { boxes, refused } = await discoverBoxes([root]);
	expect(boxes.map(({ descriptor: { id } }) => id)).toEqual(["plain"]);
	for (const { dispose } of boxes) dispose?.();
	expect(refused.map(({ folder, reason }) => [basename(folder), reason])).toEqual([
		["hard-linked", "The hard-linked Box's folder holds deps/dice@1.0.0.js, a file with another link; a sandboxed Box's folder holds only plain files and folders."],
		["linked-bundle", "The linked-bundle Box's folder holds logic.bundle.js, a link; a sandboxed Box's folder holds only plain files and folders."],
		["linked-deps", "The linked-deps Box's folder holds deps, a link; a sandboxed Box's folder holds only plain files and folders."],
		["linked-scope", "The linked-scope Box's folder holds deps/@scope, a link; a sandboxed Box's folder holds only plain files and folders."],
	]);
	expect(readFileSync(join(outside, "sentinel.js"), "utf8")).toBe("host file");
	expect(readdirSync(outside).sort()).toEqual(["@scope", "dice@1.0.0.js", "sentinel.js"]);
});

// @approved
//  The big file is sparse, so the test allocates nothing; the walk refuses it
// by its size before reading it.
test("a sandboxed Box's folder past its bytes, entries or depth is refused while it is walked", async () => {
	const parent = mkdtempSync(join(tmpdir(), "ditzy-limits-"));
	parents.push(parent);
	const box = (name: string) => { const path = join(parent, name); mkdirSync(path); return path; };
	const big = box("big");
	writeFileSync(join(big, "asset.bin"), "");
	truncateSync(join(big, "asset.bin"), SANDBOXED_FOLDER.bytes + 1);
	const many = box("many");
	for (let index = 0; index <= SANDBOXED_FOLDER.entries; index++) writeFileSync(join(many, `${index}.js`), "");
	const deep = join(box("deep"), ...Array.from({ length: SANDBOXED_FOLDER.depth + 1 }, (_, index) => `${index}`));
	mkdirSync(deep, { recursive: true });
	expect(await Promise.all(["big", "many", "deep"].map((name) => sandboxedFolder(join(parent, name), name).then(() => "read", (error: Error) => error.message)))).toEqual([
		"The big Box's folder holds more than 16 MiB.",
		"The many Box's folder holds more than 256 files and folders.",
		"The deep Box's folder holds more than 8 levels of folders.",
	]);
});

test("a file the loader replaces is written as a new file, never through a link at its name", async () => {
	const { outside } = plugins({});
	const path = join(outside, "..", "cache.js");
	symlinkSync(join(outside, "sentinel.js"), path);
	await replaceFile(path, "bundle");
	expect([readFileSync(join(outside, "sentinel.js"), "utf8"), readFileSync(path, "utf8"), lstatSync(path).isSymbolicLink()]).toEqual(["host file", "bundle", false]);
});
