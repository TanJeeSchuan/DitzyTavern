import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { addBox, builtInBoxes, checkSandboxedFolder, serverBoxes } from "../box/registry";
import { sandboxedFolder } from "../box/sandboxed-folder";
import type { Candidate } from "./candidate";

// @approved
//  Installs a candidate as a plugin under its id, a writer's action. Holding
// the candidate, it copies the candidate's files into a staging folder
// beside the plugin folder, runs the loader's own check there, which writes
// any packages, lock and bundles beside them, and renames the checked folder
// into the plugin folder, so what lands is exactly what passed, complete
// with `deps/`. The checked Box joins the running registry without touching
// the Boxes already loaded. An id any loaded Box or folder already uses is
// refused.
export const installCandidate = (database: Database, candidate: Candidate, plugins: string) => candidate.check(async () => {
	const { id } = candidate;
	const refused = (reason: string, diagnostics: readonly string[] = []) => ({ outcome: "refused", reason, diagnostics: [...diagnostics] } as const);
	const seen = new Set(serverBoxes().keys());
	const target = join(plugins, id);
	if (seen.has(id) || existsSync(target) || existsSync(join(builtInBoxes, id))) return refused(`A Box folder already uses the id ${id}.`);
	const staging = join(dirname(plugins), `.box-install-${crypto.randomUUID()}`);
	const folder = join(staging, id);
	try {
		for (const [path, text] of await sandboxedFolder(candidate.folder, id)) {
			await mkdir(dirname(join(folder, path)), { recursive: true });
			await writeFile(join(folder, path), text, { flag: "wx" });
		}
		let checked: Awaited<ReturnType<typeof checkSandboxedFolder>>;
		try {
			checked = await checkSandboxedFolder(folder, id, seen);
		} catch (error) {
			return refused("The Box did not pass the loader's check.", [error instanceof Error ? error.message : String(error)]);
		}
		try {
			await mkdir(plugins, { recursive: true });
			await rename(folder, target);
			addBox(database, checked);
		} catch (error) {
			checked.dispose();
			throw error;
		}
		return { outcome: "installed", id, label: checked.descriptor.label } as const;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
});
