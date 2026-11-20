import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("the stylesheet gate resolves cross-file declarations and checks fallback variables and dark variants", async () => {
	const root = await mkdtemp(join(tmpdir(), "stylesheet-check-"));
	const script = fileURLToPath(new URL("./check-stylesheets.ts", import.meta.url));
	const run = () => Bun.spawnSync(["bun", script], { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
	const write = (path: string, text: string) => Bun.write(join(root, "src", path), text);

	try {
		await mkdir(join(root, "src", "theme"), { recursive: true });
		await write("theme/tokens.css", `
			@import "tailwindcss";
			@theme inline { --color-*: initial; --\\61 ccent: red; @keyframes fade { from { opacity: 0; } } }
			@utility tone { --tone: blue; }
			@PROPERTY --registered { syntax: "<color>"; INITIAL-VALUE: red; inherits: true; }
			/* --input: black; */
		`);
		await write("app.css", '.item { color: var(--accent); border-color: var(--optional, var(--accent)); outline-color: var(--registered); fill: var(--tone); padding: var(--spacing); content: "var(--ignored)"; }');
		await write("app.tsx", `<div className="bg-panel data-[theme=dark]:text-white [&_.dark:hover]:text-white before:content-['dark:mode']" />`);
		const passing = run();
		expect(passing.stderr.toString()).toBe("");
		expect(passing.exitCode).toBe(0);

		await write("app.css", '.item { color: var(--input, var(--missing)); @apply dark:bg-panel; } .other { color: var(--input); }');
		await write("app.tsx", '<div className="md:dark:@md:hover:bg-panel" />');
		const failing = run();
		expect(failing.exitCode).toBe(1);
		expect(failing.stderr.toString()).toContain("src/app.css: undeclared custom property --input");
		expect(failing.stderr.toString()).toContain("src/app.css: undeclared custom property --missing");
		expect(failing.stderr.toString()).toContain("src/app.css:1: dark: utility");
		expect(failing.stderr.toString()).toContain("src/app.tsx:1: dark: utility");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
