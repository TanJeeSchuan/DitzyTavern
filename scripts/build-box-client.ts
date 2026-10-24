import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { transform, type Rule, type Selector } from "lightningcss";
import { build } from "vite";

// The modules a Box client shares with the host, as `index.html`'s import
// map names them: each specifier to the stable host chunk it is built as.
export const hostModules: Record<string, string> = JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(readFileSync(new URL("../index.html", import.meta.url), "utf8"))![1]!).imports;

const linkStylesheet = `await new Promise((resolve, reject) => document.head.append(Object.assign(document.createElement("link"), {
	rel: "stylesheet", href: new URL("./client.css", import.meta.url).href, onload: resolve, onerror: () => reject(new Error("Its stylesheet did not load.")),
})));`;

// A selector's classes, elements, pseudo-classes and combinators, enough to find it in the source.
const printed = (selector: Selector): string => selector.map((part) => {
	if (part.type === "pseudo-class") return part.kind === "is" || part.kind === "where" ? `:${part.kind}(${part.selectors.map(printed).join(", ")})` : `:${part.kind}`;
	return part.type === "class" ? `.${part.name}` : part.type === "type" ? part.name : part.type === "universal" ? "*" : part.type === "combinator" ? " " : "";
}).join("");

// Whether a selector names one of the Box's classes, `<id>` or `<id>-…`,
// directly or in every alternative of an `:is()` or `:where()`.
const owned = (selector: Selector, id: string): boolean => selector.some((part) => part.type === "class"
	? part.name === id || part.name.startsWith(`${id}-`)
	: part.type === "pseudo-class" && (part.kind === "is" || part.kind === "where") && part.selectors.every((inner) => owned(inner, id)));

// The selectors in a Box's stylesheet that name none of its classes, and so
// could match the host's elements or another Box's. The build has already
// flattened nesting. Tailwind's `properties` layer only sets its variables'
// defaults everywhere; a `@scope` root doesn't own the rules inside it.
const strays = (rules: readonly Rule[], id: string): string[] => rules.flatMap((rule) => {
	if (rule.type === "style") return rule.value.selectors.filter((selector) => !owned(selector, id)).map(printed);
	if (rule.type === "layer-block" && rule.value.name?.join(".") === "properties") return [];
	const grouping = rule.type === "media" || rule.type === "supports" || rule.type === "container" || rule.type === "layer-block" || rule.type === "starting-style" || rule.type === "scope";
	return grouping ? strays(rule.value.rules, id) : [];
});

// A Box's client module, `client.js`, built from its folder's `client.tsx`
// alone, a built-in's and a plugin's alike: the host modules stay imports the
// import map resolves, and a dynamic import is inlined, since the server serves
// no other chunk. A stylesheet the module imports is emitted beside it as
// `client.css`, and the module links it and waits for it before it resolves,
// so the host renders no surface of a Box without its styles. Tailwind runs on
// it, so `@reference "@/index.css"` lets it `@apply` the host's utilities and
// theme; every selector in it must name one of the Box's own classes.
export const buildBoxClient = async (folder: string, outDir: string): Promise<void> => {
	await build({
		configFile: false,
		root: folder,
		publicDir: false,
		logLevel: "warn",
		plugins: [react(), tailwindcss()],
		resolve: { alias: { "@/index.css": fileURLToPath(new URL("../src/index.css", import.meta.url)) } },
		define: { "process.env.NODE_ENV": JSON.stringify("production") },
		build: {
			outDir,
			emptyOutDir: true,
			lib: { entry: join(folder, "client.tsx"), formats: ["es"], fileName: () => "client.js", cssFileName: "client" },
			rolldownOptions: { external: Object.keys(hostModules), output: { codeSplitting: false } },
		},
	});
	if (!existsSync(join(outDir, "client.css"))) return;
	const id = basename(folder);
	let found: string[] = [];
	transform({ filename: "client.css", code: readFileSync(join(outDir, "client.css")), visitor: { StyleSheet: (sheet) => void (found = strays(sheet.rules, id)) } });
	if (found.length > 0) throw new Error(`The ${id} Box's stylesheet has selectors that name none of its classes, ${id} and ${id}-…: ${found.join(", ")}`);
	const module = join(outDir, "client.js");
	writeFileSync(module, `${linkStylesheet}\n${readFileSync(module, "utf8")}`);
};

// `bun run box:build <folder>` builds a plugin's client into the `dist`
// folder inside it, where the server serves it from.
if (import.meta.main) {
	const [path] = process.argv.slice(2);
	if (path === undefined) throw new Error("Name the plugin's folder: bun run box:build <folder>");
	const folder = resolve(path);
	await buildBoxClient(folder, join(folder, "dist"));
}
