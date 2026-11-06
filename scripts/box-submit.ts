import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { AuthoringLogEntry, AuthoringMeta } from "../src/shared/contract/authoring";
import { shown } from "../src/server/authoring/activity";
import { AUTHORED_ID, createCandidate, defaultAuthoringFolder, newId, SESSION_LOG, SESSION_META, withId } from "../src/server/authoring/candidate";
import { checkScenario } from "../src/server/authoring/tools";
import { pluginFolder } from "../src/server/box/registry";
import { sandboxedFolder } from "../src/server/box/sandboxed-folder";
import { installedLatest } from "../src/server/box/versions";
import { readScenarios, scenarioFiles, usageError } from "./scenario-files";

// @approved
//  Takes a Box an outside coding agent wrote back into Creator Mode: it makes
// a new saved session under the app's data folder, `cwd/data` as the
// server's, and never writes into an existing one, which a running server
// may hold open. The folder is read with `sandboxedFolder`, which refuses
// links, and copied into the session's candidate, whose id is `--box`, a Box
// Creator Mode installed (it has a `latest`), for its next version, or a new one. Each scenario
// runs as `run_scenario` does, caching its check for Install's gate, and the
// session's log holds each run as the panel's stream would have sent it, so
// opening the session shows the runs and Install replays them. The session
// has no coding model until the writer opens it. It never installs. Exits 0
// when every scenario passed, 1 when one failed (the session is written all
// the same), and 2 on wrong arguments, before anything is written.
const usage = "Usage: bun run box:submit <box folder> [--box <id>] <scenario.json or folder of them>...";
const args = process.argv.slice(2);
const flag = args.indexOf("--box");
const [box] = flag === -1 ? [undefined] : args.splice(flag, 2).slice(1);
const [folder, ...named] = args;
const files = await scenarioFiles(named);
if (folder === undefined || files.length === 0 || (flag !== -1 && box === undefined)) usageError(usage);
const scenarios = await readScenarios(files);
if (box !== undefined) {
	const home = join(pluginFolder, box);
	if (!AUTHORED_ID.test(box) || await installedLatest(home) === undefined) usageError(`--box ${box} is not a Box installed from Creator Mode in ${pluginFolder}.`);
}
const source = resolve(folder);
const sources = await sandboxedFolder(source, basename(source)).catch((error: Error) => usageError(error.message));

const id = box ?? newId();
const copied = new Map(sources);
const descriptor = sources.get("descriptor.json");
try { if (descriptor !== undefined) copied.set("descriptor.json", withId(descriptor, id)); } catch (error) { usageError(error instanceof Error ? error.message : String(error)); }

const candidate = await createCandidate(defaultAuthoringFolder(), { session: crypto.randomUUID(), id });
for (const [path, text] of copied) {
	await mkdir(dirname(join(candidate.folder, path)), { recursive: true });
	await writeFile(join(candidate.folder, path), text, { flag: "wx" });
}

const log: AuthoringLogEntry[] = [{ type: "prompt", text: `Submitted from ${source}.` }];
const failed: string[] = [];
for (const [index, input] of scenarios.entries()) {
	const call = `submitted-${index + 1}`;
	const result = await candidate.check(() => checkScenario(candidate, pluginFolder, input, AbortSignal.timeout(60_000)));
	const sent = shown(JSON.stringify(input));
	const read = shown(JSON.stringify(result));
	log.push(
		{ type: "tool", id: call, name: "run_scenario", input: sent.text, truncated: sent.truncated },
		{ type: "scenario-input", id: call, input },
		{ type: "tool-end", id: call, name: "run_scenario", isError: false, content: read.text, truncated: read.truncated },
		{ type: "scenario", id: call, result },
	);
	if (!result.ok) failed.push(`${files[index]} failed:\n${result.diagnostics.map((line) => `  ${line}`).join("\n")}`);
}
const folderOf = join(defaultAuthoringFolder(), candidate.session);
await writeFile(join(folderOf, SESSION_LOG), log.map((entry) => `${JSON.stringify(entry)}\n`).join(""), { flag: "wx" });
const meta: AuthoringMeta = { box: candidate.id, steps: 40, installed: false, updated: new Date().toISOString() };
await writeFile(join(folderOf, SESSION_META), JSON.stringify(meta), { flag: "wx" });

if (failed.length > 0) console.error(failed.join("\n"));
console.log(`${candidate.session}\n${failed.length > 0 ? "A scenario failed. Open the session in Create a Box to ask its agent." : "Open it in Create a Box to install."}`);
process.exit(failed.length > 0 ? 1 : 0);
