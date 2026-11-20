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
const cssEscape = /\\(?:(?<hex>[\da-f]{1,6})(?:\r\n|[ \t\r\n\f])?|(?<literal>[^\r\n\f]))/gi;
const cssComment = String.raw`\/\*[\s\S]*?\*\/`;
const cssGap = String.raw`(?:\s|${cssComment})*`;
const noFallback = new RegExp(String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|${cssComment}|(?<![\w-])var\(${cssGap}((?:${cssEscape.source}|[^\\\s,()'"/])+)${cssGap}\)`, "giu");

function cssIdentifier(value: string): string {
	return value.replace(cssEscape, (_, hex: string | undefined, literal: string | undefined) => {
		if (hex === undefined) return literal ?? "";
		const code = Number.parseInt(hex, 16);
		return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\ufffd" : String.fromCodePoint(code);
	});
}

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
		const property = cssIdentifier(prop);
		if (property.startsWith("--")) declared.add(property);
		if (property.toLowerCase() === "initial-value" && parent?.type === "atrule" && parent.name.toLowerCase() === "property") {
			declared.add(cssIdentifier(parent.params));
		}
		for (const [, name] of value.matchAll(noFallback)) {
			if (name === undefined) continue;
			const identifier = cssIdentifier(name);
			if (identifier.startsWith("--")) required.add(identifier);
		}
	});
	sheet.walkAtRules("import", (rule) => {
		if (/^["']tailwindcss(?:\/theme\.css)?["']/.test(rule.params)) importsDefaultTheme = true;
	});
	sheet.walkAtRules("apply", (rule) => {
		const firstLine = (rule.source?.start?.line ?? 1) + (rule.raws.afterName?.match(/\n/g)?.length ?? 0);
		checkDarkUtilities(rule.params, extension, filename, firstLine);
	});
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
