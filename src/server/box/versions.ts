import { Value } from "@sinclair/typebox/value";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BoxId } from "../../shared/contract/box";
import { cachedScenarioCheck, type ScenarioInput, type ScenarioResult } from "../../shared/contract/authoring";
import { checkSandboxedFolder } from "./registry";
import { isBuildOutput } from "./sandboxed-build";
import { replaceFile, sandboxedFolder, type SandboxedFiles } from "./sandboxed-folder";

// @approved
//  A versioned Box is a sandboxed plugin installed through Creator Mode. Its
// id folder holds each installed version under `versions/<hash>/`, never
// written after it is created; `latest`, the hash new Chats pin and the
// catalog lists; and `checks/`, the `run_scenario` results Install is gated
// on, one per version and scenario. A folder without `versions/` is a trusted
// plugin or a sandboxed folder made by hand, which keeps one version.
export const VERSION_PATTERN = /^[0-9a-f]{64}$/;
export const isVersioned = (home: string): boolean => existsSync(join(home, "versions"));
export const versionFolder = (home: string, version: string): string => join(home, "versions", version);

/** @approved A version's name: the sha256 of its source files and `deps.lock.json`, by sorted path; packages and bundles are built from them. */
export const versionHash = (files: SandboxedFiles): string => {
	const hash = createHash("sha256");
	for (const [path, text] of [...files].filter(([path]) => !isBuildOutput(path)).sort(([a], [b]) => a.localeCompare(b))) hash.update(`${path}\0${text}\0`);
	return hash.digest("hex");
};

/** @approved The version `latest` names, or undefined before the first Install; a `latest` that names no version refuses the Box. */
export const readLatest = async (home: string): Promise<string | undefined> => {
	const file = Bun.file(join(home, "latest"));
	if (!await file.exists()) return undefined;
	const version = (await file.text()).trim();
	if (!VERSION_PATTERN.test(version)) throw new Error("Its latest file names no version.");
	return version;
};
export const writeLatest = (home: string, version: string): Promise<void> => replaceFile(join(home, "latest"), `${version}\n`);

/** @approved Every version folder the Box holds, by hash. */
export const listVersions = async (home: string): Promise<string[]> =>
	(await readdir(join(home, "versions")).catch(() => [])).filter((name) => VERSION_PATTERN.test(name)).sort();

// @approved
//  Creates a version from a candidate folder: its files are copied into a
// staging folder beside the versions, which the loader's own check builds,
// writing its packages, lock and bundles there, and the result is hashed and
// renamed to `versions/<hash>/`, so a version folder is never seen half
// filled. A version folder that already exists holds the same sources, so
// creating it again leaves it alone. The caller owns the checked runtime.
export const createVersion = async (home: string, source: string, id: BoxId, seen: ReadonlySet<BoxId>) => {
	const files = await sandboxedFolder(source, id);
	await mkdir(join(home, "versions"), { recursive: true });
	const staging = join(home, "versions", `.staging-${crypto.randomUUID()}`);
	try {
		for (const [path, text] of files) {
			await mkdir(dirname(join(staging, path)), { recursive: true });
			await writeFile(join(staging, path), text, { flag: "wx" });
		}
		const checked = await checkSandboxedFolder(staging, id, seen);
		try {
			const version = versionHash(await sandboxedFolder(staging, id));
			const target = versionFolder(home, version);
			if (!existsSync(target)) await rename(staging, target).catch((error: Error) => existsSync(target) ? undefined : Promise.reject(error));
			return { version, checked };
		} catch (error) {
			checked.dispose();
			throw error;
		}
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
};

const scenarioHash = (input: ScenarioInput) => createHash("sha256").update(JSON.stringify(input)).digest("hex");

/** @approved Caches one scenario's result for the version it ran on; the id folder gets its `versions/`, so it is a managed folder from then on. */
export const recordCheck = async (home: string, version: string, input: ScenarioInput, result: ScenarioResult): Promise<void> => {
	await mkdir(join(home, "versions"), { recursive: true });
	await mkdir(join(home, "checks"), { recursive: true });
	await replaceFile(join(home, "checks", `${version}-${scenarioHash(input)}.json`), JSON.stringify({ input, result }));
};

/** @approved Whether any scenario's cached result passed on exactly this version. */
export const passedCheck = async (home: string, version: string): Promise<boolean> => {
	const names = (await readdir(join(home, "checks")).catch(() => [])).filter((name) => name.startsWith(`${version}-`));
	for (const name of names) {
		const parsed: unknown = await Bun.file(join(home, "checks", name)).json().catch(() => undefined);
		if (Value.Check(cachedScenarioCheck, parsed) && parsed.result.ok) return true;
	}
	return false;
};
