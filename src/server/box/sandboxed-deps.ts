import { Type } from "@sinclair/typebox";
import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BoxId } from "../../shared/contract/box";
import { assertChecked } from "../../shared/contract/box-descriptor";

/** @approved Where a sandboxed Box's packages come from, each as one prebundled ES module. */
export const esmOrigin = "https://esm.sh";
/** @approved The most one fetched module may hold: a package bigger than the UI bundle's cap could never ship. */
const MODULE_BYTES = 4 * 1024 * 1024;
const INDIRECTIONS = 4;
const FETCH_MS = 30_000;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const lockFile = Type.Record(Type.String(), Type.String({ pattern: "^[0-9a-f]{64}$" }));

// @approved
//  esm.sh answers a package URL with a stub that only re-exports its bundle,
// `export * from "<path>";` and `export { default } from "<path>";` after a
// comment. The path such a stub re-exports, or undefined for any other
// module, such as one that also imports `/node/*.mjs` polyfills.
const reexport = /^export\s*(?:\*|\{\s*default\s*\})\s*from\s*"([^"]+)";?$/;
const indirection = (source: string) => {
	const targets = new Set(source.replaceAll(/\/\*[^]*?\*\//g, "").split("\n").map((line) => line.trim()).filter((line) => line !== "").map((line) => reexport.exec(line)?.[1]));
	const [target] = targets;
	return targets.size === 1 ? target : undefined;
};

// @approved
//  Fetches `<name>@<version>` as one module: the `?bundle` URL, then each
// same-origin stub it re-exports, until a module with no imports is left.
// Anything else is refused, since the sandbox resolves no imports.
const fetchPackage = async (origin: string, key: string, refuse: (reason: string) => Error) => {
	let url = new URL(`/${key}?bundle&target=es2022`, origin);
	for (let hop = 0; hop <= INDIRECTIONS; hop++) {
		let response: Response;
		try {
			response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_MS) });
		} catch (error) {
			throw refuse(`could not be fetched from ${url.href}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!response.ok) throw refuse(`could not be fetched: ${url.href} answered ${response.status}`);
		const source = await response.text();
		if (Buffer.byteLength(source) > MODULE_BYTES) throw refuse(`is over ${MODULE_BYTES / 1024 / 1024} MiB`);
		const imports = new Bun.Transpiler({ loader: "js" }).scanImports(source);
		if (imports.length === 0) return source;
		const target = indirection(source);
		const next = target === undefined ? undefined : new URL(target, url);
		if (next?.origin !== url.origin) throw refuse(`imports ${(imports.find(({ path }) => path !== target) ?? imports[0])?.path}; a package must bundle into one module with no imports`);
		url = next;
	}
	throw refuse(`still re-exports another module after ${INDIRECTIONS} indirections`);
};

/** @approved The text of a file the Box ships, refusing anything but a regular file, so a link out of its folder is never followed. */
const ownFile = async (path: string) => (await lstat(path)).isFile() ? await Bun.file(path).text() : undefined;

// @approved
//  Each package a sandboxed Box declares, as the module source its build
// imports. A package is kept in `deps/<name>@<version>.js` with its sha256 in
// `deps.lock.json`: a file whose hash matches is used without fetching, so a
// Box copied with its `deps/` loads offline; one that does not match is
// refused; a missing one is fetched from esm.sh and must match the hash the
// lock already holds for it, if any. The lock is rewritten to the declared
// packages when it changes. Nothing fetched runs on the host.
export const pinnedPackages = async (folder: string, id: BoxId, dependencies: Readonly<Record<string, string>>, origin = esmOrigin) => {
	const lockPath = join(folder, "deps.lock.json");
	const held = await ownFile(lockPath).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? "{}" : Promise.reject(error));
	if (held === undefined) throw new Error(`The ${id} Box's deps.lock.json is not a file.`);
	const lock: unknown = JSON.parse(held);
	assertChecked(lockFile, lock, `The ${id} Box's deps.lock.json`);
	const pinned = new Map<string, string>();
	const hashes: Record<string, string> = {};
	for (const [name, version] of Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))) {
		const key = `${name}@${version}`;
		const refuse = (reason: string) => new Error(`The ${id} Box's dependency ${key} ${reason}.`);
		const path = join(folder, "deps", `${key}.js`);
		const stored = await ownFile(path).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
		if (stored === undefined) throw refuse(`is kept in deps/${key}.js, which is not a file`);
		const expected = lock[key];
		const source = stored !== null && expected !== undefined ? stored : await fetchPackage(origin, key, refuse);
		const hash = sha256(source);
		if (expected !== undefined && hash !== expected) throw refuse(`does not match its hash in deps.lock.json`);
		if (source !== stored) {
			await mkdir(dirname(path), { recursive: true });
			await Bun.write(path, source);
		}
		pinned.set(name, source);
		hashes[key] = hash;
	}
	const written = `${JSON.stringify(hashes, null, "\t")}\n`;
	if (written !== held && (Object.keys(hashes).length > 0 || held !== "{}")) await Bun.write(lockPath, written);
	return pinned;
};
