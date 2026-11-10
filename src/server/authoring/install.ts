import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { addBox, builtInBoxes, checkSandboxedFolder, serverBoxes } from "../box/registry";
import { sandboxedFolder } from "../box/sandboxed-folder";
import type { Candidate } from "./candidate";

// @approved
//  Installs a candidate as a plugin under its id, a writer's action. Holding
// the candidate, it copies the candidate's files into a staging folder
// beside the plugin folder, runs the loader's own check there, which writes
// any packages, lock and bundles beside them, then publishes what passed,
// complete with `deps/`, by renaming the whole checked folder to the target,
// so the target is never seen half filled, and never in place of a folder
// that appeared meanwhile, which refuses the Install and is left alone. A
// POSIX rename replaces an empty folder, so there the target is first claimed
// by creating it exclusively and the rename lands on that claim, which is
// removed again, while empty, if the rename fails. Windows refuses to rename
// onto any folder, so there the rename itself is the claim. The checked Box joins the running
// registry without touching the Boxes already loaded. An id any loaded Box
// or folder already uses is refused.
/** @approved Whether `rename` replaces an existing empty folder: POSIX does, Windows refuses any existing folder. */
const renameReplaces = process.platform !== "win32";

export const installCandidate = (database: Database, candidate: Candidate, plugins: string) => candidate.check(async () => {
	const { id } = candidate;
	const refused = (reason: string, diagnostics: readonly string[] = []) => ({ outcome: "refused" as const, reason, diagnostics: [...diagnostics] });
	const seen = new Set(serverBoxes().keys());
	const target = join(plugins, id);
	const taken = refused(`A Box folder already uses the id ${id}.`);
	if (seen.has(id) || existsSync(target) || existsSync(join(builtInBoxes, id))) return taken;
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
			const claimed = renameReplaces ? await mkdir(target).then(() => true, (error: NodeJS.ErrnoException) => error.code === "EEXIST" ? false : Promise.reject(error)) : true;
			const published = claimed && await rename(folder, target).then(() => true, async (error: NodeJS.ErrnoException) => {
				if (renameReplaces) await rmdir(target).catch(() => undefined);
				else if (existsSync(target)) return false;
				throw error;
			});
			if (!published) {
				checked.dispose();
				return taken;
			}
			addBox(database, checked);
		} catch (error) {
			checked.dispose();
			throw error;
		}
		return { outcome: "installed" as const, id, label: checked.descriptor.label };
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
});
