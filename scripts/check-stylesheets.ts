import { extname } from "node:path";
import { Scanner } from "@tailwindcss/oxide";
import { parse } from "postcss";
import { __unstable__loadDesignSystem } from "tailwindcss";

const files = new Bun.Glob("src/**/*.{css,html,js,jsx,mjs,cjs,ts,tsx,mts,cts,md,mdx,json}");
const runtimeProperties = new Map<string, readonly string[]>([
	["src/styles/cast.css", ["--radix-select-trigger-width"]], // Radix Select exposes the measured Control trigger width.
	["src/styles/swipe-browser.css", ["--offset", "--distance", "--deal"]], // SwipeBrowser sets each card's animation values inline.
	["src/styles/workspace.css", ["--radix-select-trigger-width"]], // Radix Select exposes the measured app trigger width.
]);
const defaultTheme = await Bun.file(new URL(import.meta.resolve("tailwindcss/theme.css"))).text();
const design = await __unstable__loadDesignSystem(defaultTheme);
const scanner = new Scanner({});
const declared = new Set<string>();
const references = new Map<string, Set<string>>();
const errors: string[] = [];
const noFallback = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?<![\w-])var\(\s*(--[\p{L}\p{N}_-]+)\s*\)/giu;

function checkDarkUtilities(content: string, extension: string, filename: string, firstLine = 1) {
	if (!content.includes("dark:")) return;
	for (const { candidate, position } of scanner.getCandidatesWithPositions({ content, extension })) {
		if (!candidate.includes("dark:") ||
			!design.parseCandidate(candidate).some(({ variants }) => variants.some((variant) => variant.kind === "static" && variant.root === "dark"))) continue;
		const line = firstLine + content.slice(0, position).split("\n").length - 1;
		errors.push(`${filename}:${line}: dark: utility ${candidate} follows the OS theme. Use a data-theme selector.`);
	}
}

let importsDefaultTheme = false;
for (const path of [...files.scanSync()].sort()) {
	const filename = path.replaceAll("\\", "/");
	const content = await Bun.file(path).text();
	const extension = extname(filename).slice(1);
	if (extension !== "css") {
		checkDarkUtilities(content, extension, filename);
		continue;
	}

	const sheet = parse(content, { from: filename });
	const required = new Set<string>();
	sheet.walkDecls(({ prop, value, parent }) => {
		if (prop.startsWith("--")) declared.add(prop);
		if (prop === "initial-value" && parent?.type === "atrule" && parent.name === "property") declared.add(parent.params);
		for (const [, name] of value.matchAll(noFallback)) if (name !== undefined) required.add(name);
	});
	sheet.walkAtRules("import", (rule) => {
		if (/^["']tailwindcss(?:\/theme\.css)?["']/.test(rule.params)) importsDefaultTheme = true;
	});
	sheet.walkAtRules("apply", (rule) => checkDarkUtilities(rule.params, extension, filename, rule.source?.start?.line));
	references.set(filename, required);
}

if (importsDefaultTheme) parse(defaultTheme).walkDecls(/^--/, ({ prop }) => { declared.add(prop); });

for (const [filename, required] of references) {
	for (const name of required) {
		if (!declared.has(name) && !runtimeProperties.get(filename)?.includes(name)) errors.push(`${filename}: undeclared custom property ${name}`);
	}
}

if (errors.length > 0) {
	console.error(errors.join("\n"));
	process.exitCode = 1;
}
