import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

type Location = { name: string; start: number };
type Clone = { firstFile: Location; secondFile: Location; fragment: string };
type Report = { duplicates: Clone[] };

const baseline = new URL("../.jscpd-baseline.json", import.meta.url);
await mkdir(".reports", { recursive: true });
const output = await mkdtemp(".reports/jscpd-");

try {
	const detector = Bun.spawn(["jscpd", "src", "--reporters", "json", "--output", output, "--no-tips"], { stdout: "ignore", stderr: "inherit" });
	const status = await detector.exited;
	if (status !== 0) throw new Error(`jscpd exited with code ${status}`);

	const report: Report = await Bun.file(join(output, "jscpd-report.json")).json();
	// A clone keeps its identity when lines move or the detector swaps its two files.
	const clones = report.duplicates.map(({ firstFile, secondFile, fragment }) => {
		const files = [firstFile.name, secondFile.name].sort().join(" ↔ ");
		const hash = createHash("sha256").update(fragment.replace(/\s+/g, "")).digest("hex");
		return { firstFile, secondFile, fingerprint: `${files} | ${hash}` };
	});
	if (Bun.argv.includes("--write-baseline")) {
		await Bun.write(baseline, JSON.stringify(clones.map(({ fingerprint }) => fingerprint).sort(), null, "\t") + "\n");
		console.log(`Recorded ${clones.length} clones.`);
	} else {
		const remaining: string[] = await Bun.file(baseline).json();
		for (const { firstFile, secondFile, fingerprint } of clones) {
			const match = remaining.indexOf(fingerprint);
			if (match !== -1) {
				remaining.splice(match, 1);
				continue;
			}
			console.error(`New clone: src/${firstFile.name}:${firstFile.start} ↔ src/${secondFile.name}:${secondFile.start}`);
			process.exitCode = 1;
		}
		if (process.exitCode !== 1) console.log(`No new clones (${clones.length} found).`);
	}
} finally {
	await rm(output, { recursive: true, force: true });
}
