import { transform } from "lightningcss";

const files = new Bun.Glob("src/**/*.{css,html,js,jsx,mjs,cjs,ts,tsx,mts,cts,md,mdx,json}");
const darkUtility = /(?<![\w\\/-])dark:[!\w\[-]/;
const runtimeProperties = new Map<string, readonly string[]>([
	["src/styles/cast.css", ["--radix-select-trigger-width"]], // Radix Select exposes the measured Control trigger width.
	["src/styles/swipe-browser.css", ["--offset", "--distance", "--deal"]], // SwipeBrowser sets each card's animation values inline.
	["src/styles/workspace.css", ["--radix-select-trigger-width"]], // Radix Select exposes the measured app trigger width.
]);
const encoder = new TextEncoder();
const declared = new Set<string>();
const references = new Map<string, Set<string>>();
const errors: string[] = [];

for (const path of [...files.scanSync()].sort()) {
	const filename = path.replaceAll("\\", "/");
	const source = await Bun.file(path).text();
	for (const [line, text] of source.split("\n").entries()) {
		if (darkUtility.test(text)) errors.push(`${filename}:${line + 1}: dark: utility follows the OS theme. Use a data-theme selector.`);
	}
	if (!filename.endsWith(".css")) continue;
	const required = new Set<string>();
	transform({
		filename,
		code: encoder.encode(source),
		customAtRules: { theme: { prelude: "*", body: "style-block" } },
		visitor: {
			Declaration: {
				custom: ({ name }) => { if (name.startsWith("--")) declared.add(name); },
			},
			Variable(variable) {
				if (variable.fallback == null) required.add(variable.name.ident);
			},
		},
	});
	references.set(filename, required);
}

for (const [filename, required] of references) {
	for (const name of required) {
		if (!declared.has(name) && !runtimeProperties.get(filename)?.includes(name)) errors.push(`${filename}: undeclared custom property ${name}`);
	}
}

if (errors.length > 0) {
	console.error(errors.join("\n"));
	process.exitCode = 1;
}
