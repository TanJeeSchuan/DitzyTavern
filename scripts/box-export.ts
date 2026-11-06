import { Value } from "@sinclair/typebox/value";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { authoringMeta, authoringSessionParams } from "../src/shared/contract/authoring";
import { AUTHORED_ID, defaultAuthoringFolder, loggedScenarios, SESSION_LOG, SESSION_META } from "../src/server/authoring/candidate";
import { sandboxedFolder } from "../src/server/box/sandboxed-folder";
import { usageError } from "./scenario-files";

// @approved
//  Hands a saved Creator Mode session to a coding agent outside the app:
// writes into `<dir>`, which must be new or empty, the session's candidate
// as a folder named for its Box id, each scenario its log saved whole as
// `scenarios/<n>.json` (identical ones once), and `AGENTS.md`, the contract
// followed by how to check and submit. It reads only the session's own
// folder under the app's data folder, `cwd/data` as the server's, and the
// candidate through `sandboxedFolder`, which refuses links. Exits 0 once
// written, 2 on wrong arguments or a session it can't read.
const [session, dir, ...extra] = process.argv.slice(2);
if (session === undefined || dir === undefined || extra.length > 0) usageError("Usage: bun run box:export <session id> <dir>");
if (!Value.Check(authoringSessionParams, { session })) usageError(`${session} is not a session id.`);
const folder = join(defaultAuthoringFolder(), session);
const meta: unknown = await Bun.file(join(folder, SESSION_META)).json().catch(() => undefined);
if (!Value.Check(authoringMeta, meta) || !AUTHORED_ID.test(meta.box)) usageError(`No saved session ${session} in ${defaultAuthoringFolder()}.`);
const files = await sandboxedFolder(join(folder, meta.box), meta.box).catch((error: Error) => usageError(error.message));
const scenarios = [...new Map(loggedScenarios(await Bun.file(join(folder, SESSION_LOG)).text().catch(() => "")).map((input) => [JSON.stringify(input), input])).values()];

const target = resolve(dir);
const existing = await readdir(target).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : usageError(`${target} is not a folder: ${error.message}`));
if (existing.length > 0) usageError(`${target} is not empty.`);
const box = join(target, meta.box);
const write = async (path: string, text: string) => {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text, { flag: "wx" });
};
for (const [path, text] of files) await write(join(box, path), text);
for (const [index, input] of scenarios.entries()) await write(join(target, "scenarios", `${index + 1}.json`), `${JSON.stringify(input, null, 2)}\n`);
const scenarioFiles = join(target, "scenarios", "*.json");
const submit = `bun run box:submit ${box}${meta.installed ? ` --box ${meta.box}` : ""} ${scenarioFiles}`;
await write(join(target, "AGENTS.md"), `${await Bun.file(join(import.meta.dir, "../src/server/authoring/contract.md")).text()}
## Working outside the app

You work on files with your own tools; the tools named above are the app's, and these commands stand in for them. The Box is the folder \`${meta.box}/\` beside this file, named for its id; keep \`descriptor.json\`'s id as it is. Run both commands in the app's folder, \`${process.cwd()}\`.

- **Check** with \`bun run box:scenario ${box} ${scenarioFiles}\`. It runs each scenario as \`run_scenario\` does and prints the results as JSON, exiting 0 when all pass, 1 when one fails. Add a scenario as a new file in \`scenarios/\`. A \`from\` scenario fails here, since this folder has no installed versions; submitting runs it against the installed Box.
- **Submit** with \`${submit}\` once every scenario passes. It copies the folder into a new Creator Mode session and runs the scenarios there${meta.installed ? `; \`--box ${meta.box}\` makes it the next version of the installed Box, which Install checks against \`latest\`` : ", as a new Box"}. It never installs: tell the writer the session id it prints, which they open in Create a Box to install.
`);
console.log(`Exported session ${session} to ${target}.`);
