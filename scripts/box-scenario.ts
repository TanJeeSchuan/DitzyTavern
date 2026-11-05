import { basename, resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { scenarioInput, type ScenarioInput } from "../src/shared/contract/authoring";
import { runScenario } from "../src/server/authoring/scenario";

// @approved
//  Checks a sandboxed Box folder against scenario files, as Creator Mode's
// `run_scenario` does, for a coding agent working outside the app. It only
// checks: it never installs, never reaches the app's data, and never
// imports a trusted Box's server.ts. The folder's name is the Box id. It
// prints each scenario's result as JSON and exits 0 when all pass, 1 when
// one fails, and 2 when the arguments or a scenario file are wrong.
const usage = "Usage: bun run box:scenario <box folder> <scenario.json>...";
const fail = (message: string): never => {
	console.error(message);
	process.exit(2);
};

const [folder, ...files] = process.argv.slice(2);
if (folder === undefined || files.length === 0) fail(usage);
const scenarios: ScenarioInput[] = [];
for (const file of files) {
	let parsed: unknown;
	try {
		parsed = await Bun.file(file).json();
	} catch (error) {
		fail(`${file} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const errors = [...Value.Errors(scenarioInput, parsed)].slice(0, 5).map(({ path, message }) => `  ${path || "/"}: ${message}`);
	if (errors.length > 0) fail(`${file} is not a scenario:\n${errors.join("\n")}`);
	scenarios.push(Value.Decode(scenarioInput, parsed));
}

const box = resolve(folder ?? "");
const results = [];
for (const scenario of scenarios) results.push(await runScenario(box, basename(box), new Set(), scenario, AbortSignal.timeout(60_000)));
console.log(JSON.stringify(results.map((result, index) => ({ scenario: files[index], ...result })), null, 2));
process.exit(results.every(({ ok }) => ok) ? 0 : 1);
