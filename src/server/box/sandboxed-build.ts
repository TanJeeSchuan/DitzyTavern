import type { BunPlugin } from "bun";
import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { BoxId } from "../../shared/contract/box";
import { esmOrigin, pinnedPackages } from "./sandboxed-deps";

/** @approved The most each bundle a sandboxed Box's build writes may hold. */
export const SANDBOXED_BUNDLE_BYTES = { logic: 1024 * 1024, ui: 4 * 1024 * 1024 } as const;
type Part = keyof typeof SANDBOXED_BUNDLE_BYTES;

const transpiler = new Bun.Transpiler({ loader: "js" });
/** @approved An import attribute, static or dynamic, which would pick a loader other than JavaScript or skip the plugin. */
const importAttribute = /\b(?:with|assert)\s*:?\s*\{\s*["']?type["']?\s*:/;
const packagePrefix = "package:";

/** @approved The path inside the Box's folder that `specifier` names from `importer`, when its real path is a `.js` or `.mjs` file there. */
const contained = async (root: string, importer: string, specifier: string) => {
	const real = await realpath(join(root, dirname(importer), specifier)).catch(() => undefined);
	return real !== undefined && real.startsWith(root + sep) && /\.m?js$/.test(real) && (await stat(real)).isFile() ? relative(root, real) : undefined;
};

// @approved
//  Resolves and loads every module of a sandboxed Box's build itself, the
// entry point included, so the bundler never resolves a guest path, reads a
// `tsconfig.json` or `package.json`, or follows a link on its own. A relative
// import must name a `.js` or `.mjs` file whose real path is inside the Box's
// folder; a bare one must name a declared package, loaded from the source
// `pinnedPackages` verified. Anything else, and any import attribute, is
// refused before the file it names is read.
const confined = (root: string, entry: string, packages: ReadonlyMap<string, string>): BunPlugin => ({
	name: "sandboxed-box",
	setup(build) {
		build.onResolve({ filter: /.*/ }, async (args) => {
			const [specifier, importer] = args.kind === "entry-point-build" ? [`./${entry}`, ""] : [args.path, args.importer];
			if (importer.startsWith(packagePrefix)) throw new Error(`The package ${importer.slice(packagePrefix.length)} imports ${specifier}.`);
			if (specifier.startsWith(".")) {
				const path = await contained(root, importer, specifier);
				if (path === undefined) throw new Error(`${importer || "The build"} imports ${specifier}, which is not a .js or .mjs file inside the Box's folder.`);
				return { path, namespace: "box" };
			}
			if (packages.has(specifier)) return { path: `${packagePrefix}${specifier}`, namespace: "box" };
			throw new Error(`${importer} imports ${specifier}; a sandboxed Box imports its own files by relative path and the packages its descriptor.json declares.`);
		});
		build.onLoad({ filter: /.*/, namespace: "box" }, async ({ path }) => {
			const contents = path.startsWith(packagePrefix) ? packages.get(path.slice(packagePrefix.length)) : await Bun.file(join(root, path)).text();
			if (contents === undefined) throw new Error(`There is no package ${path}.`);
			if (!path.startsWith(packagePrefix) && importAttribute.test(contents)) throw new Error(`${path} uses an import attribute, which a sandboxed Box cannot.`);
			return { contents, loader: "js" };
		});
	},
});

// @approved
//  Builds one part from the Box's folder. Build settings come only from these
// options: guest macros would run on the host, so they are off, and no
// environment variable is inlined. `logic.js` becomes the ES module QuickJS
// evaluates, `ui.js` the script the frame's Worker runs. Computed imports
// stay in the output and fail inside the sandbox; a literal one left behind
// is refused.
const build = async (root: string, id: BoxId, part: Part, packages: ReadonlyMap<string, string>) => {
	const refuse = (reason: string) => new Error(`The ${id} Box's ${part}.js ${reason}`);
	// @approved
	// bun-types does not declare `macros`, which Bun.build reads; spread from a variable, it passes the type check.
	const untyped = { macros: false };
	const result = await Bun.build({ ...untyped, entrypoints: [`${part}.js`], target: "browser", format: part === "logic" ? "esm" : "iife", minify: true, env: "disable", throw: false, plugins: [confined(root, `${part}.js`, packages)] });
	if (!result.success) throw refuse(`did not build: ${result.logs.map(({ message }) => message).join("; ")}`);
	const [output, ...more] = result.outputs;
	if (output === undefined || more.length > 0) throw refuse(`built ${result.outputs.length} files; a sandboxed Box's ${part}.js builds into one.`);
	const code = await output.text();
	const [left] = transpiler.scanImports(code);
	if (left !== undefined) throw refuse(`still imports ${left.path} once built.`);
	if (Buffer.byteLength(code) > SANDBOXED_BUNDLE_BYTES[part]) throw refuse(`builds to more than its ${SANDBOXED_BUNDLE_BYTES[part] / 1024 / 1024} MiB cap.`);
	return code;
};

// @approved
//  The hash of everything a build may read: each regular file in the Box's
// folder, `deps/` and the lock included, but not the bundles it writes.
const inputsHash = async (root: string) => {
	const hash = createHash("sha256");
	const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile())
		.map((entry) => relative(root, join(entry.parentPath, entry.name))).filter((path) => path !== "logic.bundle.js" && path !== "ui.bundle.js").sort();
	for (const path of files) hash.update(`${path}\0`).update(await Bun.file(join(root, path)).bytes()).update("\0");
	return hash.digest("hex");
};

// @approved
//  A sandboxed plugin's `logic.js` and, unless its window is the passage
// timeline, `ui.js`, as the sandbox runs them. A part with no imports runs as
// written. One that imports is built, once its packages are pinned, into
// `<part>.bundle.js`, whose first line holds the hash of the inputs it was
// built from; the loader reuses a bundle whose hash still matches and
// rebuilds it otherwise.
export const sandboxedSources = async (folder: string, id: BoxId, withUi: boolean, dependencies: Readonly<Record<string, string>> = {}, origin = esmOrigin) => {
	const root = await realpath(folder);
	let prepared: Promise<{ readonly packages: ReadonlyMap<string, string>; readonly hash: string }> | undefined;
	const prepare = () => prepared ??= pinnedPackages(root, id, dependencies, origin).then(async (packages) => ({ packages, hash: await inputsHash(root) }));
	const source = async (part: Part) => {
		const path = await contained(root, "", `./${part}.js`);
		if (path === undefined) throw new Error(`The ${id} Box's ${part}.js is not a file inside its folder.`);
		const written = await Bun.file(join(root, path)).text();
		if (transpiler.scanImports(written).length === 0) return written;
		const { packages, hash } = await prepare();
		const bundle = Bun.file(join(root, `${part}.bundle.js`));
		const stamp = `// inputs ${hash}\n`;
		const cached = await bundle.exists() ? await bundle.text() : undefined;
		if (cached?.startsWith(stamp)) return cached.slice(stamp.length);
		const code = await build(root, id, part, packages);
		await Bun.write(bundle, stamp + code);
		return code;
	};
	return { logic: await source("logic"), ui: withUi ? await source("ui") : undefined };
};
