import { spawnSync } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();
const OXLINT_BIN = path.join(ROOT, "node_modules", "oxlint", "bin", "oxlint");
const RULE_CODE = "anti-slop(no-unapproved-comments)";

interface Diagnostic {
	readonly code: string;
	readonly severity: "warning" | "error";
	readonly message: string;
	readonly filename: string;
	readonly labels?: readonly { readonly span: { readonly line: number } }[];
}

interface OxlintReport {
	readonly diagnostics: readonly Diagnostic[];
	readonly number_of_files: number;
}

/** Run the comment-approval audit: aggregate findings of `no-unapproved-comments`. */
const result = spawnSync(process.execPath, [OXLINT_BIN, "--format", "json", "src"], {
	encoding: "utf8",
	maxBuffer: 64 * 1024 * 1024,
});
if (result.status !== 0) {
	console.error(result.stderr.trim() || `oxlint exited with status ${result.status}`);
	process.exit(1);
}

// SAFETY: `oxlint --format json` emits diagnostics carrying the rule code, severity,
// filename, and label spans; the interface mirrors exactly that shape.
const report = JSON.parse(result.stdout) as OxlintReport;
const findings = report.diagnostics.filter((diagnostic) => diagnostic.code === RULE_CODE);

const perFile = new Map<string, number>();
for (const finding of findings) {
	perFile.set(finding.filename, (perFile.get(finding.filename) ?? 0) + 1);
}
const rows = [...perFile.entries()].sort((a, b) => b[1] - a[1]);

console.log(`unapproved comments: ${findings.length} across ${rows.length} of ${report.number_of_files} files`);
console.log(`approval directive: put @approved first in a block or trailing comment, or use an exact // @approved line first in a standalone comment run.`);
console.log("");
for (const [file, count] of rows) {
	console.log(`${String(count).padStart(5)}  ${file}`);
}
