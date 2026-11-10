import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BoxId } from "../../shared/contract/box";
import { unversionedBoxIds } from "../box/registry";
import { createVersion, writeLatest } from "../box/versions";

/** @approved A sandboxed Box's files by path, as a candidate holds them. */
export type BoxFiles = Readonly<Record<string, string>>;

/** @approved Writes `files` into a new folder at `folder`. */
export const writeBoxFiles = (folder: string, files: BoxFiles) => {
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(folder, path)), { recursive: true });
		writeFileSync(join(folder, path), text);
	}
};

// @approved
//  A versioned plugin Box in its own plugin folder under `.scratch/`, one
// version created from each file set in order, as Install creates them, with
// `latest` naming the first. Loading the plugin folder loads `latest`.
export const writeVersionedBox = async (id: BoxId, versions: readonly BoxFiles[]) => {
	const root = join(".scratch", `versioned-${crypto.randomUUID()}`);
	const plugins = join(root, "plugins");
	const home = join(plugins, id);
	const hashes: string[] = [];
	for (const [index, files] of versions.entries()) {
		const source = join(root, `source-${index}`);
		writeBoxFiles(source, files);
		const { version, checked } = await createVersion(home, source, id, unversionedBoxIds());
		checked.dispose();
		hashes.push(version);
	}
	await writeLatest(home, hashes[0]!); // @approved Every caller passes at least one version.
	return { plugins, home, versions: hashes, remove: () => rmSync(root, { recursive: true, force: true }) };
};
