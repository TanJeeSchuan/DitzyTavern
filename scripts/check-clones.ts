import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript5";

type Point = { position: number; line: number; column: number };
type Location = { name: string; start: number; startLoc: Point; endLoc: Point };
type Report = { duplicates: { firstFile: Location; secondFile: Location }[] };

const baseline = ".jscpd-baseline.json";

// JSX trims the leading and trailing indentation on lines split by a newline.
// A single-line space or a space within a line remains part of the rendered text.
const jsxText = (text: string) => {
	const lines = text.split(/\r\n|[\r\n\u2028\u2029]/);
	return lines.map((line, index) => {
		const start = index === 0 ? line : line.trimStart();
		return index === lines.length - 1 ? start : start.trimEnd();
	}).filter(Boolean).join(" ");
};

// Parse whole files so strings and template text keep their original contents.
const tokenRanges = (source: ts.SourceFile, node: ts.Node): { start: number; end: number; text: string }[] => {
	if (node.kind === ts.SyntaxKind.JsxText || node.kind === ts.SyntaxKind.JsxTextAllWhiteSpaces) {
		const text = jsxText(source.text.slice(node.pos, node.end));
		return text === "" ? [] : [{ start: node.pos, end: node.end, text }];
	}
	if (node.kind <= ts.SyntaxKind.LastToken) {
		const start = node.getStart(source);
		return [{ start, end: node.end, text: source.text.slice(start, node.end) }];
	}
	return node.getChildren(source).flatMap((child) => tokenRanges(source, child));
};

const readSource = async (name: string) => {
	const bytes = Buffer.from(await Bun.file(join("src", name)).arrayBuffer());
	const text = bytes.toString();
	const lineStarts = [0];
	for (let newline = bytes.indexOf(10); newline !== -1; newline = bytes.indexOf(10, newline + 1)) lineStarts.push(newline + 1);
	// The JSON detector reports offsets in LF-normalized text. Line and byte
	// column locate the same token in the checkout, where CRLF can add bytes.
	const offset = ({ line, column }: Point) => {
		const start = lineStarts[line - 1];
		if (start === undefined) throw new Error(`Invalid jscpd line in ${name}: ${line}`);
		return bytes.subarray(0, start + column).toString().length;
	};
	const source = /\.(?:[cm]?[jt]sx?|json)$/.test(name) ? ts.createSourceFile(name, text, ts.ScriptTarget.Latest) : null;
	return { offset, text, ranges: source === null ? [] : tokenRanges(source, source) };
};

const cloneLocations = (report: Report) => {
	const byFile = new Map<string, Location[]>();
	for (const { firstFile, secondFile } of report.duplicates) {
		for (const location of [firstFile, secondFile]) {
			const name = location.name.replaceAll("\\", "/");
			let locations = byFile.get(name);
			if (locations === undefined) byFile.set(name, locations = []);
			locations.push(location);
		}
	}
	return byFile;
};

const mergedLocations = (locations: Location[]) => {
	const merged: Location[] = [];
	for (const location of locations.sort((a, b) => a.startLoc.position - b.startLoc.position)) {
		const previous = merged.at(-1);
		if (previous !== undefined && previous.endLoc.position >= location.startLoc.position) {
			if (previous.endLoc.position < location.endLoc.position) merged[merged.length - 1] = { ...previous, endLoc: location.endLoc };
		} else {
			merged.push(location);
		}
	}
	return merged;
};

// Each baseline token can be spent once. A shorter surviving clone consumes
// only its own span, leaving the other tokens available for disjoint clones.
const consume = (available: string[], wanted: string) => {
	for (const [index, block] of available.entries()) {
		const start = block.indexOf(wanted);
		if (start === -1) continue;
		available.splice(index, 1, block.slice(0, start + 1), block.slice(start + wanted.length - 1));
		return true;
	}
	return false;
};

await mkdir(".reports", { recursive: true });
const output = await mkdtemp(".reports/jscpd-");
try {
	const detector = Bun.spawn(["bun", "x", "--no-install", "jscpd", "src", "--reporters", "json", "--output", output, "--no-tips"], { stdout: "ignore", stderr: "inherit" });
	const status = await detector.exited;
	if (status !== 0) throw new Error(`jscpd exited with code ${status}`);

	const report: Report = await Bun.file(join(output, "jscpd-report.json")).json();
	const write = Bun.argv.includes("--write-baseline");
	const recorded: Record<string, string[]> = write ? {} : await Bun.file(baseline).json();
	let count = 0;
	for (const [name, locations] of [...cloneLocations(report)].sort(([a], [b]) => a.localeCompare(b))) {
		const source = await readSource(name);
		const spans = [];
		let scannedThrough = 0;
		const ordered = write ? mergedLocations(locations) : locations.sort((a, b) =>
			a.startLoc.position - b.startLoc.position || b.endLoc.position - a.endLoc.position);
		for (const { start, startLoc, endLoc } of ordered) {
			const from = Math.max(scannedThrough, source.offset(startLoc));
			const to = source.offset(endLoc);
			if (from >= to) continue;
			const tokens = source.ranges.filter((range) => range.start < to && range.end > from);
			scannedThrough = Math.max(to, tokens.at(-1)?.end ?? 0);
			if (tokens.length === 0 && source.ranges.length > 0) continue;
			const lexemes = tokens.length ? tokens.map(({ text }) => text) : [source.text.slice(from, to)];
			const hashes = lexemes.map((text) => Bun.hash(text.replaceAll("\r\n", "\n")).toString(36));
			spans.push({ start, content: ` ${hashes.join(" ")} ` });
		}
		count += spans.length;
		if (write) {
			recorded[name] = spans.map(({ content }) => content);
			continue;
		}
		const available = recorded[name] ?? [];
		for (const { start, content } of spans.sort((a, b) => b.content.length - a.content.length)) {
			if (consume(available, content)) continue;
			console.error(`New clone occurrence: src/${name}:${start}`);
			process.exitCode = 1;
		}
	}
	if (write) {
		await Bun.write(baseline, JSON.stringify(recorded, null, "\t") + "\n");
		console.log(`Recorded ${count} clone occurrences.`);
	} else if (process.exitCode !== 1) {
		console.log(`No new clones (${count} occurrences).`);
	}
} finally {
	await rm(output, { recursive: true, force: true });
}
