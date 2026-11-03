import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxedBox } from "./sandboxed";
import { sandboxedSources } from "./sandboxed-build";

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

test("a Box's own files and pinned packages build into bundles with no imports, which the next load reuses until an input changes", async () => {
	const { box } = boxIn({
		"logic.js": 'import { faces } from "./lib/faces.js";\nimport roll from "dice";\nexport default { moves: { render: () => `${faces} ${roll(4)}` } };',
		"ui.js": 'import { faces } from "./lib/faces.js";\nhost.render(`<p>${faces}</p>`);',
		"lib/faces.js": "export const faces = 6;",
		"deps/.keep": "",
	});
	pin(box, "dice@1.0.0", "var roll = (n) => n % 6 + 1; export { roll as default };");
	const built = await sandboxedSources(box, "probe", true, { dice: "1.0.0" }, offline);
	const { box: logic, dispose } = await sandboxedBox("probe", built.logic);
	expect(logic.moves?.render({}, "Ann")).toBe("6 5");
	dispose();
	expect(new Bun.Transpiler({ loader: "js" }).scanImports(built.ui!)).toEqual([]);
	const stamped = readFileSync(join(box, "logic.bundle.js"), "utf8");
	expect(stamped).toStartWith("// inputs ");

	writeFileSync(join(box, "logic.bundle.js"), `${stamped.split("\n")[0]}\nexport default { kept: true };`);
	expect((await sandboxedSources(box, "probe", true, { dice: "1.0.0" }, offline)).logic).toBe("export default { kept: true };");
	writeFileSync(join(box, "lib/faces.js"), "export const faces = 20;");
	expect((await sandboxedSources(box, "probe", true, { dice: "1.0.0" }, offline)).logic).toContain("20");
});

test("a Box with no imports runs its files as written and builds nothing", async () => {
	const { box } = boxIn({ "logic.js": "export default {};", "ui.js": "host.render('');" });
	expect(await sandboxedSources(box, "probe", true)).toEqual({ logic: "export default {};", ui: "host.render('');" });
	expect([existsSync(join(box, "logic.bundle.js")), existsSync(join(box, "deps.lock.json"))]).toEqual([false, false]);
});

test("an import that reaches outside the Box's sources, or a macro, fails the build without reading or running anything on the host", async () => {
	const attacks = {
		macro: 'import { pwn } from "./evil.js" with { type: "macro" };\nexport default pwn();',
		escape: 'import secret from "../secret.js";\nexport default secret;',
		absolute: "import secret from \"%parent%/secret.js\";\nexport default secret;",
		alias: 'import { boxSdkVersion } from "@/box-sdk/shared";\nexport default boxSdkVersion;',
		text: 'import secret from "../secret.txt" with { type: "text" };\nexport default secret;',
		linked: 'import secret from "./linked.js";\nexport default secret;',
		builtin: 'import { readFileSync } from "node:fs";\nexport default readFileSync;',
	};
	const reasons: Record<string, string> = {};
	for (const [name, logic] of Object.entries(attacks)) {
		const { parent, box } = boxIn({ "evil.js": `export const pwn = () => require("node:fs").writeFileSync(${JSON.stringify(join(tmpdir(), "ditzy-pwned"))}, "x");` });
		writeFileSync(join(box, "logic.js"), logic.replace("%parent%", parent));
		symlinkSync(join(parent, "secret.js"), join(box, "linked.js"));
		reasons[name] = await sandboxedSources(box, "probe", false, {}, offline).then(() => "built", (error: Error) => error.message.replace(parent, "<parent>"));
		expect(existsSync(join(box, "logic.bundle.js"))).toBe(false);
	}
	expect(existsSync(join(tmpdir(), "ditzy-pwned"))).toBe(false);
	const outside = "which is not a .js or .mjs file inside the Box's folder.";
	const bare = "a sandboxed Box imports its own files by relative path and the packages its descriptor.json declares.";
	expect(reasons).toEqual({
		macro: "The probe Box's logic.js did not build: logic.js uses an import attribute, which a sandboxed Box cannot.",
		escape: `The probe Box's logic.js did not build: logic.js imports ../secret.js, ${outside}`,
		absolute: `The probe Box's logic.js did not build: logic.js imports <parent>/secret.js; ${bare}`,
		alias: `The probe Box's logic.js did not build: logic.js imports @/box-sdk/shared; ${bare}`,
		text: "The probe Box's logic.js did not build: logic.js uses an import attribute, which a sandboxed Box cannot.",
		linked: `The probe Box's logic.js did not build: logic.js imports ./linked.js, ${outside}`,
		builtin: `The probe Box's logic.js did not build: logic.js imports node:fs; ${bare}`,
	});
});

test("a bundle over its cap is refused, naming the Box and the part", async () => {
	const { box } = boxIn({ "logic.js": 'import big from "big";\nexport default { moves: { render: () => big } };', "deps/.keep": "" });
	pin(box, "big@1.0.0", `export default ${JSON.stringify("x".repeat(1024 * 1024))};`);
	await expect(sandboxedSources(box, "probe", false, { big: "1.0.0" }, offline)).rejects.toThrow("The probe Box's logic.js builds to more than its 1 MiB cap.");
});
