import type { BunPlugin } from "bun";
import { createHash } from "node:crypto";
import { join, posix } from "node:path";
import type { BoxId } from "../../shared/contract/box";
import { esmOrigin, pinnedPackages } from "./sandboxed-deps";
import { replaceFile, type SandboxedFiles } from "./sandboxed-folder";

/** @approved The most each bundle a sandboxed Box's build writes may hold. */
export const SANDBOXED_BUNDLE_BYTES = { logic: 1024 * 1024, ui: 4 * 1024 * 1024 } as const;
type Part = keyof typeof SANDBOXED_BUNDLE_BYTES;

const transpiler = new Bun.Transpiler({ loader: "js" });
const packagePrefix = "package:";
const bundles = new Set(["logic.bundle.js", "ui.bundle.js"]);
/** @approved A module the build may load from the Box's folder: a `.js` or `.mjs` file, not a package kept in `deps/` and not a bundle. */
const isModule = (path: string) => /\.m?js$/.test(path) && !path.startsWith("deps/") && !bundles.has(path);

// @approved
//  Resolves and loads every module of a sandboxed Box's build itself, the
// entry point included, from the folder's snapshot, which holds no links, so
// the bundler never reads a path, a `tsconfig.json` or a `package.json` on
// its own. A relative import must name a module in the snapshot; a bare one
// must name a declared package, loaded from the source `pinnedPackages`
// verified. Anything else is refused. An import attribute that skips the
// plugin is refused elsewhere: a macro by `macros: false`, and a `sqlite`
// import by the literal import it leaves in the output. Every other
// attribute reaches this plugin, which loads the file as JavaScript.
const confined = (files: SandboxedFiles, entry: string, packages: ReadonlyMap<string, string>): BunPlugin => ({
	name: "sandboxed-box",
	setup(build) {
		build.onResolve({ filter: /.*/ }, (args) => {
			const [specifier, importer] = args.kind === "entry-point-build" ? [`./${entry}`, ""] : [args.path, args.importer];
			if (importer.startsWith(packagePrefix)) throw new Error(`The package ${importer.slice(packagePrefix.length)} imports ${specifier}.`);
			if (specifier.startsWith(".")) {
				const path = posix.normalize(posix.join(posix.dirname(importer), specifier));
				if (!isModule(path) || !files.has(path)) throw new Error(`${importer || "The build"} imports ${specifier}, which is not a .js or .mjs file of the Box's own.`);
				return { path, namespace: "box" };
			}
			if (packages.has(specifier)) return { path: `${packagePrefix}${specifier}`, namespace: "box" };
			throw new Error(`${importer} imports ${specifier}; a sandboxed Box imports its own files by relative path and the packages its descriptor.json declares.`);
		});
		build.onLoad({ filter: /.*/, namespace: "box" }, ({ path }) => {
			const contents = path.startsWith(packagePrefix) ? packages.get(path.slice(packagePrefix.length)) : files.get(path);
			if (contents === undefined) throw new Error(`There is no module ${path}.`);
			return { contents, loader: "js" };
		});
	},
});

/** @approved Refuses a part, as written, built or cached, that still imports anything, that exports anything when it is `ui.js`, or that is over its part's cap. */
const checkedBundle = (id: BoxId, part: Part, code: string) => {
	const { imports: [left], exports } = transpiler.scan(code);
	if (left !== undefined) throw new Error(`The ${id} Box's ${part}.js still imports ${left.path} once built.`);
	if (part === "ui" && exports.length > 0) throw new Error(`The ${id} Box's ui.js exports ${exports.join(", ")}; it runs as a script.`);
	if (Buffer.byteLength(code) > SANDBOXED_BUNDLE_BYTES[part]) throw new Error(`The ${id} Box's ${part}.js builds to more than its ${SANDBOXED_BUNDLE_BYTES[part] / 1024 / 1024} MiB cap.`);
	return code;
};

// @approved
//  Builds one part from the folder's snapshot. Build settings come only from
// these options: guest macros would run on the host, so they are off, and no
// environment variable is inlined. Both parts build as ES modules, so an
// import the plugin never saw (a `sqlite` import attribute) stays a literal
// import the check refuses; built as a script, Bun would turn it into a
// `require` call no import scan sees. `logic.js` is the module QuickJS
// evaluates; `ui.js`, which may not export, runs in the frame's Worker
// wrapped in a function. Computed imports stay in the output and fail inside
// the sandbox.
const build = async (files: SandboxedFiles, id: BoxId, part: Part, packages: ReadonlyMap<string, string>) => {
	const refuse = (reason: string) => new Error(`The ${id} Box's ${part}.js ${reason}`);
	// @approved
	// bun-types does not declare `macros`, which Bun.build reads; spread from a variable, it passes the type check.
	const untyped = { macros: false };
	const result = await Bun.build({ ...untyped, entrypoints: [`${part}.js`], target: "browser", format: "esm", minify: true, env: "disable", throw: false, plugins: [confined(files, `${part}.js`, packages)] });
	if (!result.success) throw refuse(`did not build: ${result.logs.map(({ message }) => message).join("; ")}`);
	const [output, ...more] = result.outputs;
	if (output === undefined || more.length > 0) throw refuse(`built ${result.outputs.length} files; a sandboxed Box's ${part}.js builds into one.`);
	return await output.text();
};

/** @approved A built `ui.js` runs as a script, in a function so its top-level names cannot meet the Worker prelude's; a built `logic.js` stays the module it is. */
const script = (part: Part, code: string) => part === "ui" ? `(() => {\n${code}\n})();` : code;

/** @approved The hash of everything a build reads: the Box's own modules and each pinned package, by name. */
const inputsHash = (files: SandboxedFiles, packages: ReadonlyMap<string, string>) => {
	const hash = createHash("sha256");
	for (const [path, text] of [...files].filter(([path]) => isModule(path)).sort(([a], [b]) => a.localeCompare(b))) hash.update(`${path}\0${text}\0`);
	for (const [name, source] of [...packages].sort(([a], [b]) => a.localeCompare(b))) hash.update(`${packagePrefix}${name}\0${source}\0`);
	return hash.digest("hex");
};

// @approved
//  A sandboxed plugin's `logic.js` and, unless its window is the passage
// timeline, `ui.js`, as the sandbox runs them, from the folder's snapshot. A
// part with no imports runs as written. One that imports is built, once its
// packages are pinned, into `<part>.bundle.js`, whose first line holds the
// hash of the inputs it was built from; the loader reuses a bundle whose hash
// still matches and rebuilds it otherwise. A reused bundle passes the same
// checks as a fresh one.
export const sandboxedSources = async (folder: string, id: BoxId, withUi: boolean, files: SandboxedFiles, dependencies: Readonly<Record<string, string>> = {}, origin = esmOrigin, signal?: AbortSignal) => {
	let prepared: Promise<{ readonly packages: ReadonlyMap<string, string>; readonly hash: string }> | undefined;
	const prepare = () => prepared ??= pinnedPackages(folder, id, files, dependencies, origin, signal).then((packages) => ({ packages, hash: inputsHash(files, packages) }));
	const source = async (part: Part) => {
		const written = files.get(`${part}.js`);
		if (written === undefined) throw new Error(`The ${id} Box has no ${part}.js.`);
		if (transpiler.scanImports(written).length === 0) return checkedBundle(id, part, written);
		const { packages, hash } = await prepare();
		const stamp = `// inputs ${hash}\n`;
		const cached = files.get(`${part}.bundle.js`);
		if (cached?.startsWith(stamp)) return script(part, checkedBundle(id, part, cached.slice(stamp.length)));
		const code = checkedBundle(id, part, await build(files, id, part, packages));
		signal?.throwIfAborted();
		await replaceFile(join(folder, `${part}.bundle.js`), stamp + code);
		return script(part, code);
	};
	return { logic: await source("logic"), ui: withUi ? await source("ui") : undefined };
};
