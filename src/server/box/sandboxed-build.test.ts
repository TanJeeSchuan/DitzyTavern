import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxedBox } from "./sandboxed";
import { sandboxedSources } from "./sandboxed-build";
import { sandboxedFolder } from "./sandboxed-folder";

const parents: string[] = [];
afterEach(() => { for (const made of parents.splice(0)) rmSync(made, { recursive: true, force: true }); });

/** @approved A Box folder inside a parent that also holds host files, each of which would build if it were read. */
const boxIn = (files: Record<string, string>) => {
	const parent = mkdtempSync(join(tmpdir(), "ditzy-build-"));
	parents.push(parent);
	for (const name of ["secret.js", "secret.txt"]) writeFileSync(join(parent, name), 'export default "host secret";');
	const box = join(parent, "probe");
	mkdirSync(box);
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(join(box, name, ".."), { recursive: true });
		writeFileSync(join(box, name), text);
	}
	return { parent, box };
};
const pin = (box: string, name: string, source: string) => {
	writeFileSync(join(box, "deps", `${name}.js`), source);
	writeFileSync(join(box, "deps.lock.json"), JSON.stringify({ [name]: new Bun.CryptoHasher("sha256").update(source).digest("hex") }));
};
const offline = "http://127.0.0.1:9";
/** @approved Builds as the loader does: the folder's snapshot first. */
const sources = async (box: string, withUi: boolean, dependencies: Record<string, string> = {}) => await sandboxedSources(box, "probe", withUi, await sandboxedFolder(box, "probe"), dependencies, offline);

const dice = {
	"logic.js": 'import { faces } from "./lib/faces.js";\nimport roll from "dice";\nexport default { moves: { render: () => `${faces} ${roll(4)}` } };',
	"ui.js": 'import { faces } from "./lib/faces.js";\nhost.render(`<p>${faces}</p>`);',
	"lib/faces.js": "export const faces = 6;",
	"deps/.keep": "",
};
const roll = "var roll = (n) => n % 6 + 1; export { roll as default };";

// @approved
//  A rebuild replaces the bundle with a new file, so an unchanged inode shows
// the bundle was reused, and a changed one that it was rebuilt.
test("a Box's own files and pinned packages build into bundles with no imports, which the next load reuses until an input changes", async () => {
	const { box } = boxIn(dice);
	pin(box, "dice@1.0.0", roll);
	const built = await sources(box, true, { dice: "1.0.0" });
	const { box: logic, dispose } = await sandboxedBox("probe", built.logic);
	expect(logic.moves?.render({}, "Ann")).toBe("6 5");
	dispose();
	expect(new Bun.Transpiler({ loader: "js" }).scanImports(built.ui!)).toEqual([]);
	const inode = () => statSync(join(box, "logic.bundle.js")).ino;
	const first = inode();
	expect((await sources(box, true, { dice: "1.0.0" })).logic).toBe(built.logic);
	expect(inode()).toBe(first);
	writeFileSync(join(box, "lib/faces.js"), "export const faces = 20;");
	expect((await sources(box, true, { dice: "1.0.0" })).logic).toContain("20");
	expect(inode()).not.toBe(first);
});

test("a cached bundle whose stamp matches still answers to its part's cap", async () => {
	const { box } = boxIn(dice);
	pin(box, "dice@1.0.0", roll);
	await sources(box, false, { dice: "1.0.0" });
	const [stamp] = readFileSync(join(box, "logic.bundle.js"), "utf8").split("\n");
	writeFileSync(join(box, "logic.bundle.js"), `${stamp}\nexport default ${JSON.stringify("x".repeat(2 * 1024 * 1024))};`);
	await expect(sources(box, false, { dice: "1.0.0" })).rejects.toThrow("The probe Box's logic.js builds to more than its 1 MiB cap.");
});

test("the build reads the bytes the folder's snapshot holds, not whatever the file holds by then", async () => {
	const { box } = boxIn(dice);
	pin(box, "dice@1.0.0", roll);
	const files = await sandboxedFolder(box, "probe");
	writeFileSync(join(box, "lib/faces.js"), 'export const faces = "swapped";');
	expect((await sandboxedSources(box, "probe", false, files, { dice: "1.0.0" }, offline)).logic).not.toContain("swapped");
});

test("a Box with no imports runs its files as written and builds nothing", async () => {
	const { box } = boxIn({ "logic.js": "export default {};", "ui.js": "host.render('');" });
	expect(await sources(box, true)).toEqual({ logic: "export default {};", ui: "host.render('');" });
	expect([existsSync(join(box, "logic.bundle.js")), existsSync(join(box, "deps.lock.json"))]).toEqual([false, false]);
});

// @approved
//  Every import below names a host file holding a module that would build.
// `sqlite` and `macro` attributes skip the plugin in Bun 1.4.4: a called
// macro fails with macros off, one never called is dropped and leaves a
// dangling name, and a `sqlite` import is left in the output, which the
// output check refuses. Every other attribute reaches the plugin.
test("an import that reaches outside the Box's sources, or a macro, fails the build without reading or running anything on the host", async () => {
	const pwned = join(tmpdir(), "ditzy-pwned");
	const attacks = {
		macro: 'import { pwn } from "./evil.js" with { type: "macro" };\nexport default pwn();',
		uncalledMacro: 'import pwn from "../secret.js" with { type: "macro" };\nexport default pwn;',
		escape: 'import secret from "../secret.js";\nexport default secret;',
		absolute: "import secret from \"%parent%/secret.js\";\nexport default secret;",
		alias: 'import { boxSdkVersion } from "@/box-sdk/shared";\nexport default boxSdkVersion;',
		text: 'import secret from "../secret.txt" with { type: "text" };\nexport default secret;',
		unknownType: 'import secret from "../secret.js" with { type: "bogus" };\nexport default secret;',
		sqlite: 'import secret from "../secret.js" with { type: "sqlite" };\nexport default secret;',
		dynamicSqlite: 'export default import("../secret.js", { with: { type: "sqlite" } });',
		builtin: 'import { readFileSync } from "node:fs";\nexport default readFileSync;',
	};
	const reasons: Record<string, string> = {};
	for (const [name, logic] of Object.entries(attacks)) {
		const { parent, box } = boxIn({ "evil.js": `export const pwn = () => require("node:fs").writeFileSync(${JSON.stringify(pwned)}, "x");` });
		writeFileSync(join(box, "logic.js"), logic.replace("%parent%", parent));
		reasons[name] = await sources(box, false).then(({ logic: built }) => built.includes("host secret") ? "read the host" : "built", (error: Error) => error.message.replace(parent, "<parent>"));
		if (reasons[name] !== "built") expect(existsSync(join(box, "logic.bundle.js"))).toBe(false);
	}
	expect(existsSync(pwned)).toBe(false);
	const failed = "The probe Box's logic.js did not build: logic.js imports";
	const outside = "which is not a .js or .mjs file of the Box's own.";
	const bare = "a sandboxed Box imports its own files by relative path and the packages its descriptor.json declares.";
	expect(reasons).toEqual({
		macro: "The probe Box's logic.js did not build: Macros are disabled",
		uncalledMacro: "built",
		escape: `${failed} ../secret.js, ${outside}`,
		absolute: `${failed} <parent>/secret.js; ${bare}`,
		alias: `${failed} @/box-sdk/shared; ${bare}`,
		text: `${failed} ../secret.txt, ${outside}`,
		unknownType: `${failed} ../secret.js, ${outside}`,
		sqlite: "The probe Box's logic.js still imports ../secret.js once built.",
		dynamicSqlite: "The probe Box's logic.js still imports ../secret.js once built.",
		builtin: `${failed} node:fs; ${bare}`,
	});
});

test("a bundle over its cap is refused, naming the Box and the part", async () => {
	const { box } = boxIn({ "logic.js": 'import big from "big";\nexport default { moves: { render: () => big } };', "deps/.keep": "" });
	pin(box, "big@1.0.0", `export default ${JSON.stringify("x".repeat(1024 * 1024))};`);
	await expect(sources(box, false, { big: "1.0.0" })).rejects.toThrow("The probe Box's logic.js builds to more than its 1 MiB cap.");
});
