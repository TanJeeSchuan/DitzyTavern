import { Type } from "@sinclair/typebox";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BoxId } from "../../shared/contract/box";
import { assertChecked } from "../../shared/contract/box-descriptor";
import { replaceFile, type SandboxedFiles } from "./sandboxed-folder";

/** @approved Where a sandboxed Box's packages come from, each as one prebundled ES module. */
export const esmOrigin = "https://esm.sh";
/** @approved The most one package may hold: one bigger than the UI bundle's cap could never ship. */
export const PACKAGE_BYTES = 4 * 1024 * 1024;
/** @approved The most packages, and package bytes, one Box may declare, shipped in `deps/` or fetched. */
export const BOX_PACKAGES = 16;
export const BOX_PACKAGE_BYTES = 8 * 1024 * 1024;
const INDIRECTIONS = 4;
const FETCH_MS = 30_000;
const mebibytes = (bytes: number) => `${bytes / 1024 / 1024} MiB`;

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

/** @approved A response's text, counted as it arrives: past `cap` bytes the stream is cancelled and nothing more is read. */
const cappedText = async (response: Response, cap: number, over: () => Error) => {
	const chunks: Uint8Array[] = [];
	let size = 0;
	const reader = response.body?.getReader();
	for (let chunk = await reader?.read(); chunk !== undefined && !chunk.done; chunk = await reader?.read()) {
		size += chunk.value.byteLength;
		if (size > cap) {
			await reader?.cancel();
			throw over();
		}
		chunks.push(chunk.value);
	}
	return Buffer.concat(chunks).toString("utf8");
};

// @approved
//  Fetches `<name>@<version>` as one module: the `?bundle` URL, then each
// same-origin stub it re-exports, until a module with no imports is left.
// Anything else is refused, since the sandbox resolves no imports.
const fetchPackage = async (origin: string, key: string, cap: number, over: () => Error, refuse: (reason: string) => Error, signal: AbortSignal | undefined) => {
	let url = new URL(`/${key}?bundle&target=es2022`, origin);
	for (let hop = 0; hop <= INDIRECTIONS; hop++) {
		let response: Response;
		try {
			response = await fetch(url, { redirect: "error", signal: signal === undefined ? AbortSignal.timeout(FETCH_MS) : AbortSignal.any([signal, AbortSignal.timeout(FETCH_MS)]) });
		} catch (error) {
			signal?.throwIfAborted();
			throw refuse(`could not be fetched from ${url.href}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw refuse(`could not be fetched: ${url.href} answered ${response.status}`);
		}
		const source = await cappedText(response, cap, over);
		const imports = new Bun.Transpiler({ loader: "js" }).scanImports(source);
		if (imports.length === 0) return source;
		const target = indirection(source);
		const next = target === undefined ? undefined : new URL(target, url);
		if (next?.origin !== url.origin) throw refuse(`imports ${(imports.find(({ path }) => path !== target) ?? imports[0])?.path}; a package must bundle into one module with no imports`);
		url = next;
	}
	throw refuse(`still re-exports another module after ${INDIRECTIONS} indirections`);
};

// @approved
//  Each package a sandboxed Box declares, as the module source its build
// imports. A package is kept in `deps/<name>@<version>.js` with its sha256 in
// `deps.lock.json`: a file whose hash matches is used without fetching, so a
// Box copied with its `deps/` loads offline; one that does not match is
// refused; a missing one is fetched from esm.sh and must match the hash the
// lock already holds for it, if any. Shipped or fetched, a Box's packages
// stay within their count and byte caps, checked before each fetch and as
// each response arrives. Files are read from the folder's snapshot and
// written by replacement; the lock is rewritten to the declared packages
// when it changes. Nothing fetched runs on the host.
export const pinnedPackages = async (folder: string, id: BoxId, files: SandboxedFiles, dependencies: Readonly<Record<string, string>>, origin = esmOrigin, signal?: AbortSignal) => {
	const declared = Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b));
	if (declared.length > BOX_PACKAGES) throw new Error(`The ${id} Box declares ${declared.length} dependencies; a sandboxed Box may declare at most ${BOX_PACKAGES}.`);
	const held = files.get("deps.lock.json") ?? "{}";
	const lock: unknown = JSON.parse(held);
	assertChecked(lockFile, lock, `The ${id} Box's deps.lock.json`);
	const pinned = new Map<string, string>();
	const hashes: Record<string, string> = {};
	let total = 0;
	for (const [name, version] of declared) {
		const key = `${name}@${version}`;
		const refuse = (reason: string) => new Error(`The ${id} Box's dependency ${key} ${reason}.`);
		const remaining = BOX_PACKAGE_BYTES - total;
		const cap = Math.min(PACKAGE_BYTES, remaining);
		const over = () => refuse(cap === PACKAGE_BYTES ? `is over ${mebibytes(PACKAGE_BYTES)}` : `takes the Box's packages over ${mebibytes(BOX_PACKAGE_BYTES)}`);
		const stored = files.get(`deps/${key}.js`);
		const expected = lock[key];
		const source = stored !== undefined && expected !== undefined ? stored : await fetchPackage(origin, key, cap, over, refuse, signal);
		if (Buffer.byteLength(source) > cap) throw over();
		total += Buffer.byteLength(source);
		const hash = sha256(source);
		if (expected !== undefined && hash !== expected) throw refuse(`does not match its hash in deps.lock.json`);
		if (source !== stored) {
			const path = join(folder, "deps", `${key}.js`);
			await mkdir(dirname(path), { recursive: true });
			await replaceFile(path, source);
		}
		pinned.set(name, source);
		hashes[key] = hash;
	}
	const written = `${JSON.stringify(hashes, null, "\t")}\n`;
	if (written !== held && (declared.length > 0 || held !== "{}")) await replaceFile(join(folder, "deps.lock.json"), written);
	return pinned;
};
