import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const examples = {
	ts: `export function distinctWords(input: string[]) {
	const normalized = input.map((value) => value.toLowerCase().trim());
	const accepted = normalized.filter((value) => value !== "a b");
	const distinct = [...new Set(accepted)];
	const ordered = distinct.sort();
	const combined = ordered.join(" ");
	console.log("finished");
	return combined;
}
`,
	tsx: `export function renderExamples(inputs: string[]) {
	const labels = [...new Set(inputs.map((name) => name.trim()))];
	const accepted = labels.filter((label) => label.length > 1);
	const sorted = accepted.sort();
	const labelText = sorted.join(", ");
	console.log("finished");
	return <section>
		<strong>{sorted.length}</strong>
		<p>{labelText} a b</p>
	</section>;
}
`,
};

for (const [extension, original] of Object.entries(examples)) {
	test(`the clone baseline survives deletion and indentation and detects changed text in .${extension}`, async () => {
		await mkdir(".scratch", { recursive: true });
		const directory = await mkdtemp(".scratch/clone-check-");
		const source = join(directory, "src");
		const script = fileURLToPath(new URL("./check-clones.ts", import.meta.url));
		const run = (...args: string[]) =>
			Bun.spawnSync(["bun", script, ...args], { cwd: directory, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
		const copy = (name: string, contents: string) => Bun.write(join(source, `${name}.${extension}`), contents);

		try {
			await mkdir(source);
			await copyFile(new URL("../.jscpd.json", import.meta.url), join(directory, ".jscpd.json"));
			await Promise.all(["a", "b", "c"].map((name) => copy(name, original)));
			expect(run("--write-baseline").exitCode).toBe(0);
			await rm(join(source, `a.${extension}`));
			await Promise.all(["b", "c"].map((name) => copy(name, original.replace(/^/gm, "  "))));
			const adjusted = run();
			expect(adjusted.exitCode).toBe(0);
			expect(adjusted.stdout.toString()).toContain("2 occurrences");

			await copy("c", original);
			await copy("b", original.replace('\tconsole.log("finished");\n', ""));
			const shortened = run();
			expect(shortened.exitCode).toBe(0);
			expect(shortened.stdout.toString()).toMatch(/[1-9]\d* occurrences/);

			await Promise.all(["b", "c"].map((name) => copy(name, original.replaceAll("\n", "\r\n"))));
			const checkout = run();
			expect(checkout.exitCode).toBe(0);
			expect(checkout.stdout.toString()).toContain("2 occurrences");

			const replacement = original.replace("a b", "ab");
			await Promise.all(["b", "c"].map((name) => copy(name, replacement)));
			const result = run();
			expect(result.exitCode).toBe(1);
			expect(result.stderr.toString()).toContain(`New clone occurrence: src/b.${extension}:`);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}, 30_000);
}
