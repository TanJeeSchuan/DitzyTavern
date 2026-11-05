/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- libfx hands each tool the model's arguments as unknown JSON, which every tool checks against its schema first, and sends back whatever the tool returns: a string as it is, anything else as JSON, which is the one `typeof` here. */
import type { Static, TSchema } from "@sinclair/typebox";
import { join } from "node:path";
import { assertChecked } from "../../shared/contract/box-descriptor";
import { authoredContent, readContractInput, scenarioInput, type ScenarioInput, type ScenarioResult } from "../../shared/contract/authoring";
import { builtInBoxes, unversionedBoxIds } from "../box/registry";
import { sandboxedFolder } from "../box/sandboxed-folder";
import { recordCheck, versionHash } from "../box/versions";
import { AUTHORED_FILES, type AuthoredFile, type Candidate } from "./candidate";
import { runScenario } from "./scenario";

/** @approved The built-in sandboxed Boxes `read_contract` shows as examples, each by its source files. */
const examples = {
	mood: ["descriptor.json", "logic.ts"],
	race: ["descriptor.json", "logic.ts", "logic-engine.ts", "shared.ts", "shared-data.ts", "ui.ts", "ui-markup.ts", "ui.css"],
} as const;

/** @approved The most a tool's result may hold: libfx refuses a host tool result past 64 KiB (measured with libfx 0.0.16: 65,536 bytes pass, 65,537 fail). */
export const TOOL_RESULT_BYTES = 64 * 1024;

// @approved
//  The contract, or one built-in example: without `file`, its descriptor and
// the list of its files; with `file`, that file. The Race's sources together
// pass libfx's result limit, so an example comes one file at a time.
const contract = Bun.file(join(import.meta.dir, "contract.md"));
const readContract = async ({ example, file }: { readonly example?: keyof typeof examples; readonly file?: string }) => {
	if (example === undefined) return await contract.text();
	const files: readonly string[] = examples[example];
	if (file === undefined) return `Files: ${files.join(", ")}. Call read_contract with this example and a file to read one.\n--- ${example}/descriptor.json\n${await Bun.file(join(builtInBoxes, example, "descriptor.json")).text()}`;
	if (!files.includes(file)) throw new Error(`The ${example} example has no file ${file}; its files are ${files.join(", ")}.`);
	return await Bun.file(join(builtInBoxes, example, file)).text();
};

/** @approved A tool's result as libfx sends it, cut short with a note when it would pass libfx's limit, so the agent reads what fits instead of an error. */
export const fitted = (result: unknown) => {
	const text = typeof result === "string" ? result : JSON.stringify(result);
	if (Buffer.byteLength(text) <= TOOL_RESULT_BYTES) return result;
	const note = `\n[Cut: the result passed the ${TOOL_RESULT_BYTES / 1024} KiB a tool may return. Ask for less, such as fewer turns.]`;
	return Buffer.from(text).subarray(0, TOOL_RESULT_BYTES - Buffer.byteLength(note)).toString("utf8").replace(/\uFFFD+$/, "") + note;
};

const content = (file: AuthoredFile) => authoredContent(`The whole of ${file}, at most ${AUTHORED_FILES[file] / 1024} KiB.`);
const writes = {
	write_descriptor: ["descriptor.json", "Replaces descriptor.json. The host sets its id."],
	write_logic: ["logic.js", "Replaces logic.js, the ES module default-exporting the Box's hooks."],
	write_ui: ["ui.js", "Replaces ui.js, the script that draws the Box's window in a Worker."],
	write_css: ["ui.css", "Replaces ui.css, the Box window's stylesheet."],
} as const satisfies Record<string, readonly [AuthoredFile, string]>;

// @approved
//  Runs one scenario on the candidate, which the caller holds, and caches its
// result under the Box's id folder in `plugins`, for the version the
// candidate's files make once its build has run, which is what Install is
// gated on. A `from` scenario finds its installed versions in that folder.
export const checkScenario = async (candidate: Candidate, plugins: string, input: ScenarioInput, signal: AbortSignal): Promise<ScenarioResult> => {
	const home = join(plugins, candidate.id);
	const ran = await runScenario(candidate.folder, candidate.id, unversionedBoxIds(), input, signal, home);
	const files = await sandboxedFolder(candidate.folder, candidate.id).catch(() => undefined);
	if (files !== undefined) await recordCheck(home, versionHash(files), input, ran);
	return ran;
};

// @approved
//  The agent's tools, bound to one candidate: the contract, one content-only
// write per fixed file, and a scenario. No tool takes a path or an id, and
// every argument is checked against its schema before anything runs, since
// the arguments come from a model reading the writer's prose. Each runs
// after the previous one ends, and each call is first `spent` against the
// message's steps, which waits while the message is paused and throws once
// it is stopped. libfx's signal
// aborts when the turn is cancelled: a write still waiting is dropped, and a
// scenario stops, its package fetches included. `onScenario` hears each
// scenario's whole input and its result under its tool call's id, for the
// panel and the session's log, and `checkScenario` caches each result.
export const authoringTools = (candidate: Candidate, plugins: string, { spend, onScenario }: { readonly spend: (signal: AbortSignal) => Promise<void>; readonly onScenario: (call: string, input: ScenarioInput, result: ScenarioResult) => void }) => {
	const tool = <Schema extends TSchema>(name: string, description: string, schema: Schema, execute: (input: Static<Schema>, call: string, signal: AbortSignal) => unknown) => ({
		name, description, idempotent: true, writes: true,
		inputSchema: JSON.parse(JSON.stringify(schema)),
		execute: async (input: unknown, { executionId, signal }: { readonly executionId: string; readonly signal: AbortSignal }) => {
			await spend(signal);
			assertChecked(schema, input, `The ${name} arguments`);
			return fitted(await execute(input, executionId, signal));
		},
	});
	return [
		tool("read_contract", "Returns the sandboxed Box contract. Read it before writing any file. With `example`, returns that built-in Box's descriptor and the list of its files; add `file` to read one of them.",
			readContractInput, readContract),
		...Object.entries(writes).map(([name, [file, description]]) => tool(name, description, content(file), ({ content: text }, _, signal) => candidate.write(file, text, signal))),
		tool("run_scenario", "Loads the Box from its files as the app would and plays the scenario against it, returning its diagnostics, prompt items, records, state and read or status.",
			scenarioInput, async (input, call, signal) => {
				const result = await candidate.check(() => checkScenario(candidate, plugins, input, signal), signal);
				onScenario(call, input, result);
				return result;
			}),
	];
};
