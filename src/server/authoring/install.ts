import { existsSync } from "node:fs";
import { join } from "node:path";
import { builtInBoxes, installVersion, unversionedBoxIds } from "../box/registry";
import { sandboxedFolder } from "../box/sandboxed-folder";
import { createVersion, isVersioned, passedCheck, versionHash, writeLatest } from "../box/versions";
import type { Candidate } from "./candidate";

// @approved
//  Installs a candidate, a writer's action: holding the candidate, it creates
// a version of the Box from the candidate's files and moves `latest` to it,
// so the catalog and new insertions run it while every Chat already holding
// the Box stays on the version it pins. Only a version a scenario passed on
// installs: the cached check is looked up by the candidate's exact hash
// before anything is built, and the built version must keep that hash. An id
// a built-in or unversioned Box uses, or an id folder without `versions/`
// (a trusted plugin, or a sandboxed folder made by hand), refuses Install.
export const installCandidate = (candidate: Candidate, plugins: string) => candidate.check(async () => {
	const { id } = candidate;
	const refused = (reason: string, diagnostics: readonly string[] = []) => ({ outcome: "refused" as const, reason, diagnostics: [...diagnostics] });
	const home = join(plugins, id);
	if (unversionedBoxIds().has(id) || existsSync(join(builtInBoxes, id)) || (existsSync(home) && !isVersioned(home))) return refused(`A Box folder already uses the id ${id}.`);
	const version = versionHash(await sandboxedFolder(candidate.folder, id));
	if (!await passedCheck(home, version)) return refused("Run a scenario that passes on the Box as it is now, then install it.");
	let created: Awaited<ReturnType<typeof createVersion>>;
	try {
		created = await createVersion(home, candidate.folder, id, unversionedBoxIds());
	} catch (error) {
		return refused("The Box did not pass the loader's check.", [error instanceof Error ? error.message : String(error)]);
	}
	const { checked } = created;
	try {
		if (created.version !== version) {
			checked.dispose();
			return refused("The Box changed while it was built. Run a scenario on it again, then install it.");
		}
		await writeLatest(home, version);
		installVersion(id, home, version, checked);
	} catch (error) {
		checked.dispose();
		throw error;
	}
	return { outcome: "installed" as const, id, label: checked.descriptor.label };
});
