import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("built runtime metadata identifies the official artifact and ordinary builds are custom", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ditzy-build-"));
	try {
		const output = join(directory, "build-metadata.json");
		const generate = async (env: Record<string, string>) => {
			const child = Bun.spawn(["bun", "scripts/write-build-metadata.ts", output], { env: { ...process.env, DISTRIBUTION: "custom", BUILD_NUMBER: "", SOURCE_REVISION: "", ...env }, stderr: "pipe" });
			expect(await child.exited).toBe(0);
			return JSON.parse(await readFile(output, "utf8"));
		};
		expect(await generate({ DISTRIBUTION: "official", BUILD_NUMBER: "142", SOURCE_REVISION: "0123456789012345678901234567890123456789" })).toEqual({ distribution: "official", buildNumber: 142, revision: "0123456789012345678901234567890123456789" });
		expect(await generate({})).toEqual({ distribution: "custom", buildNumber: null, revision: null });
	} finally { await rm(directory, { recursive: true }); }
});
