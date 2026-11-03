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
// complete with `deps/`: it claims the target by creating it exclusively,
// so a folder that appeared meanwhile refuses the Install and is left alone,
// then renames the whole checked folder over its own empty claim, so the
// target is never seen half filled. If that rename fails, the claim is
// removed only while it is still empty. The checked Box joins the running
// registry without touching the Boxes already loaded. An id any loaded Box
// or folder already uses is refused.
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
			const claimed = await mkdir(target).then(() => true, (error: NodeJS.ErrnoException) => error.code === "EEXIST" ? false : Promise.reject(error));
			if (!claimed) {
				checked.dispose();
				return taken;
			}
			try {
				await rename(folder, target);
			} catch (error) {
				await rmdir(target).catch(() => undefined);
				throw error;
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
