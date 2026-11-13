import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a smoke run that fails to start leaves an existing ditzytavern container alone", () => {
	const bin = mkdtempSync(join(tmpdir(), "docker-smoke-"));
	try {
		// @approved
		// A stand-in docker that logs each call and fails `run` as a name conflict would.
		writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash\necho "$*" >> "${join(bin, "calls")}"\n[ "$1" = run ] && exit 125\nexit 0\n`);
		chmodSync(join(bin, "docker"), 0o755);
		const smoke = Bun.spawnSync(["bash", "scripts/docker-smoke.sh"], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "ignore", stderr: "ignore" });
		const calls = readFileSync(join(bin, "calls"), "utf8").trim().split("\n");
		expect(smoke.exitCode).toBe(125);
		expect(calls.filter((call) => call.split(" ").includes("ditzytavern"))).toEqual([]);
	} finally {
		rmSync(bin, { recursive: true, force: true });
	}
});
