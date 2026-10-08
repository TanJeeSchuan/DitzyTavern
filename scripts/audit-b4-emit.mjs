// Run-once PR #47 / R1 audit. Run from the repo root with:
// bun scripts/audit-b4-emit.mjs D:/Tmp/r1-emit-identity/final
// An optional third argument audits a Git revision instead of the worktree.
// Not a CI check. Raw emitted JS and diffs are retained alongside the report.
import ts from "typescript5";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

if (!process.argv[2]) throw new Error("Usage: bun scripts/audit-b4-emit.mjs OUTPUT_DIR [REVISION]");
const output = resolve(process.argv[2]);
const revision = process.argv[3];
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const changed = (from, to) => git("diff", `${from}..${to}`, "--name-only", "--", "src/client")
	.trim().split("\n").filter((file) => file.endsWith(".tsx"));
const files = changed("c0b3fb6", "631f7b7");
const b4 = new Set(changed("91c22d1", "94dfd7f"));
if (files.length !== 42 || b4.size !== 40) throw new Error("Unexpected audit file set");

const emit = (source, file) => ts.transpileModule(source, {
	fileName: file,
	compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, removeComments: true },
}).outputText;

// Compare emitted structure, preserving ALL literal bytes and expression order.
// Only code layout, redundant parentheses, and single-statement if blocks disappear.
function tree(node) {
	if (ts.isParenthesizedExpression(node)) return tree(node.expression);
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return ["String", node.text];
	if (ts.isPropertyAssignment(node) && node.name.getText() === "className") {
		return ["PropertyAssignment", tree(node.name), classValue(node.initializer)];
	}
	if (ts.isIfStatement(node)) {
		const branch = (statement) => ts.isBlock(statement) && statement.statements.length === 1 &&
			(ts.isReturnStatement(statement.statements[0]) || ts.isExpressionStatement(statement.statements[0]))
			? tree(statement.statements[0]) : tree(statement);
		return ["IfStatement", tree(node.expression), branch(node.thenStatement), ...(node.elseStatement ? [branch(node.elseStatement)] : [])];
	}
	const children = [];
	if (ts.isVariableDeclarationList(node)) children.push(["DeclarationFlags", node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)]);
	if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) children.push(["Operator", node.operator]);
	ts.forEachChild(node, (child) => { children.push(tree(child)); });
	return [ts.SyntaxKind[node.kind], ...(children.length ? children : [node.text ?? node.getText()])];
}

// Compare the requested className join idiom with the old template/string value.
// Concatenate exact bytes; never trim, collapse spaces, or discard tabs/newlines.
function classValue(node) {
	if (ts.isParenthesizedExpression(node)) return classValue(node.expression);
	let parts;
	if (ts.isTemplateExpression(node)) {
		parts = [["String", node.head.text]];
		for (const span of node.templateSpans) parts.push(tree(span.expression), ["String", span.literal.text]);
	} else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
		node.expression.name.text === "join" && ts.isArrayLiteralExpression(node.expression.expression) &&
		node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === " ") {
		parts = node.expression.expression.elements.flatMap((element, index) => index ? [["String", " "], tree(element)] : [tree(element)]);
	} else parts = [tree(node)];
	const merged = [];
	for (const part of parts) {
		const previous = merged.at(-1);
		if (part[0] === "String" && previous?.[0] === "String") previous[1] += part[1];
		else if (part[0] !== "String" || part[1] !== "") merged.push(part);
	}
	return ["ClassValue", ...merged];
}

const structure = (js) => JSON.stringify(tree(ts.createSourceFile("emit.js", js, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)));
const priorChanges = new Map([
	["src/client/GenerationDetailsPanel.tsx", "B3 showError parameter status -> outcome"],
	["src/client/MacroVariablesPanel.tsx", "B3 errorText parameter status -> outcome"],
	["src/client/ChatInformationPanel.tsx", "B3 Chat history transport refactor; outside B4"],
	["src/client/ImportChatPanel.tsx", "B3 Chat Import transport refactor; outside B4"],
]);
const report = [
	"# PR #47 R1 emit audit",
	"",
	"TypeScript 5.9.3, ReactJSX, ESNext. All 42 TSX files in c0b3fb6..631f7b7 checked; B4 contains 40.",
	"Raw JS byte identity is reported separately from emitted structure/render identity. JS printer layout and redundant syntax differ after reformatting.",
	"String and template contents remain byte-exact. Only className joins are compared by their exact concatenated value, including the conditional width expression.",
	"Earlier B3 changes are accepted only in the four named files and only when the entire emitted structure equals the independently transpiled pre-B4 revision 91c22d1.",
	"",
	"ProfileModelPicker's interpolated star aria-label and MemorySource's icon-only trace-close children both match c0b3fb6. The master fixes restore baseline semantics; they are not remaining baseline exceptions.",
	"",
	"| File | B4 | Raw JS byte-identical | Emitted structure / exact render values |",
	"| --- | --- | --- | --- |",
];
let unexpected = 0;
let b4Passed = 0;
for (const file of files) {
	const old = emit(git("show", `c0b3fb6:${file}`), file);
	const currentSource = revision ? git("show", `${revision}:${file}`) : readFileSync(file, "utf8");
	const current = emit(currentSource, file);
	const sourceTree = ts.createSourceFile(file, currentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	let multilineClass = false;
	function inspect(node) {
		if (ts.isJsxAttribute(node) && node.name.getText() === "className" && node.initializer && ts.isJsxExpression(node.initializer)) {
			const expression = node.initializer.expression;
			const literals = expression && (ts.isNoSubstitutionTemplateLiteral(expression) ? [expression] :
				ts.isTemplateExpression(expression) ? [expression.head, ...expression.templateSpans.map((span) => span.literal)] : []);
			if (literals?.some((literal) => /[\r\n]/.test(literal.text))) multilineClass = true;
		}
		ts.forEachChild(node, inspect);
	}
	inspect(sourceTree);
	let result = "IDENTICAL";
	if (multilineClass || structure(old) !== structure(current)) {
		const prior = priorChanges.get(file);
		if (!multilineClass && prior && structure(current) === structure(emit(git("show", `91c22d1:${file}`), file))) result = prior;
		else { result = "UNEXPECTED DIFFERENCE"; unexpected++; }
	}
	if (b4.has(file) && result !== "UNEXPECTED DIFFERENCE") b4Passed++;
	const directory = resolve(output, file);
	mkdirSync(directory, { recursive: true });
	writeFileSync(resolve(directory, "old.js"), old);
	writeFileSync(resolve(directory, "current.js"), current);
	writeFileSync(resolve(directory, "raw.diff"), spawnSync("git", ["-c", "core.autocrlf=false", "diff", "--no-index", "--", resolve(directory, "old.js"), resolve(directory, "current.js")], { encoding: "utf8" }).stdout);
	report.push(`| ${file} | ${b4.has(file) ? "yes" : "no"} | ${old === current ? "yes" : "no"} | ${result} |`);
}
report.push("", `B4: ${b4Passed}/40 pass. Full range: ${files.length - unexpected}/42 pass. Unexpected differences: ${unexpected}.`);
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, "report.md"), report.join("\n") + "\n");
console.log(report.join("\n"));
if (unexpected) process.exitCode = 1;
