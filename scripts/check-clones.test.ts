import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("the clone baseline survives a deleted copy and detects changed string contents", async () => {
	await mkdir(".scratch", { recursive: true });
	const directory = await mkdtemp(".scratch/clone-check-");
	const source = join(directory, "src");
	const script = fileURLToPath(new URL("./check-clones.ts", import.meta.url));
	const run = (...args: string[]) =>
		Bun.spawnSync(["bun", script, ...args], { cwd: directory, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
	const copy = (file: string, contents: string) => Bun.write(join(source, file), contents);
	const original = `export function distinctWords(input: string[]) {
	const normalized = input.map((value) => value.toLowerCase().trim());
	const accepted = normalized.filter((value) => value !== "a b");
	const ordered = [...new Set(accepted)].sort();
	return ordered.join(" ");
}
`;

	try {
		await mkdir(source);
		await Promise.all(["a.ts", "b.ts", "c.ts"].map((file) => copy(file, original)));
		expect(run("--write-baseline").exitCode).toBe(0);
		await rm(join(source, "a.ts"));
		await copy("b.ts", original.replace(/^/gm, "  "));
		expect(run().exitCode).toBe(0);

		const replacement = original.replace('"a b"', '"ab"');
		await Promise.all(["b.ts", "c.ts"].map((file) => copy(file, replacement)));
		const result = run();
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("New clone occurrence: src/b.ts:");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
