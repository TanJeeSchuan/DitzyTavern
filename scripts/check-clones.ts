import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript5";

type Location = { name: string; start: number; startLoc: { position: number }; endLoc: { position: number } };
type Report = { duplicates: { firstFile: Location; secondFile: Location }[] };

const baseline = ".jscpd-baseline.json";

// Parse whole files so strings, template text and JSX text keep their whitespace.
const tokenRanges = (source: ts.SourceFile, node: ts.Node): { start: number; end: number }[] => {
	if (node.kind === ts.SyntaxKind.JsxText || node.kind === ts.SyntaxKind.JsxTextAllWhiteSpaces) return [{ start: node.pos, end: node.end }];
	if (node.kind <= ts.SyntaxKind.LastToken) return [{ start: node.getStart(source), end: node.end }];
	return node.getChildren(source).flatMap((child) => tokenRanges(source, child));
};

const readSource = async (name: string) => {
	const bytes = Buffer.from(await Bun.file(join("src", name)).arrayBuffer());
	const text = bytes.toString();
	const source = /\.(?:[cm]?[jt]sx?|json)$/.test(name) ? ts.createSourceFile(name, text, ts.ScriptTarget.Latest) : null;
	return { bytes, text, ranges: source === null ? [] : tokenRanges(source, source) };
};

await mkdir(".reports", { recursive: true });
const output = await mkdtemp(".reports/jscpd-");
try {
	const detector = Bun.spawn(["bun", "x", "--no-install", "jscpd", "src", "--reporters", "json", "--output", output, "--no-tips"], { stdout: "ignore", stderr: "inherit" });
	const status = await detector.exited;
	if (status !== 0) throw new Error(`jscpd exited with code ${status}`);

	const report: Report = await Bun.file(join(output, "jscpd-report.json")).json();
	// jscpd can pair the same excerpt with several others and pick a new first copy after a deletion.
	const locations = new Map<string, Location>();
	for (const { firstFile, secondFile } of report.duplicates) {
		for (const location of [firstFile, secondFile]) {
			locations.set(`${location.name}:${location.startLoc.position}:${location.endLoc.position}`, location);
		}
	}

	const files = new Map<string, Awaited<ReturnType<typeof readSource>>>();
	const occurrences = [];
	for (const { name, start, startLoc, endLoc } of locations.values()) {
		const source = files.get(name) ?? await readSource(name);
		files.set(name, source);
		// jscpd reports byte offsets. TypeScript uses UTF-16 offsets.
		const from = source.bytes.subarray(0, startLoc.position).toString().length;
		const to = source.bytes.subarray(0, endLoc.position).toString().length;
		const tokens = source.ranges.filter((range) => range.start < to && range.end > from);
		const content = tokens.length ? JSON.stringify(tokens.map((range) => source.text.slice(range.start, range.end))) : source.text.slice(from, to);
		const hash = createHash("sha256").update(content).digest("hex");
		occurrences.push({ name, start, fingerprint: `${name.replaceAll("\\", "/")} | ${hash}` });
	}

	if (Bun.argv.includes("--write-baseline")) {
		await Bun.write(baseline, JSON.stringify(occurrences.map(({ fingerprint }) => fingerprint).sort(), null, "\t") + "\n");
		console.log(`Recorded ${occurrences.length} clone occurrences.`);
	} else {
		const remaining: string[] = await Bun.file(baseline).json();
		for (const { name, start, fingerprint } of occurrences) {
			const match = remaining.indexOf(fingerprint);
			if (match !== -1) {
				remaining.splice(match, 1);
				continue;
			}
			console.error(`New clone occurrence: src/${name}:${start}`);
			process.exitCode = 1;
		}
		if (process.exitCode !== 1) console.log(`No new clones (${occurrences.length} occurrences).`);
	}
} finally {
	await rm(output, { recursive: true, force: true });
}
