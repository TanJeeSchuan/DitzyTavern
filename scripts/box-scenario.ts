import { basename, resolve } from "node:path";
import { runScenario } from "../src/server/authoring/scenario";
import { readScenarios, scenarioFiles, usageError } from "./scenario-files";

// @approved
//  Checks a sandboxed Box folder against scenario files, as Creator Mode's
// `run_scenario` does, for a coding agent working outside the app. It only
// checks: it never installs, never reaches the app's data, and never
// imports a trusted Box's server.ts. The folder's name is the Box id. It
// prints each scenario's result as JSON and exits 0 when all pass, 1 when
// one fails, and 2 when the arguments or a scenario file are wrong.
const [folder, ...args] = process.argv.slice(2);
const files = await scenarioFiles(args);
if (folder === undefined || files.length === 0) usageError("Usage: bun run box:scenario <box folder> <scenario.json or folder of them>...");
const scenarios = await readScenarios(files);

const box = resolve(folder);
const results = [];
for (const scenario of scenarios) results.push(await runScenario(box, basename(box), new Set(), scenario, AbortSignal.timeout(60_000)));
console.log(JSON.stringify(results.map((result, index) => ({ scenario: files[index], ...result })), null, 2));
process.exit(results.every(({ ok }) => ok) ? 0 : 1);
