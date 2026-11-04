/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- libfx hands each tool the model's arguments as unknown JSON, which every tool checks against its schema first, and sends back whatever JSON the tool returns. */
import type { Static, TSchema } from "@sinclair/typebox";
import { join } from "node:path";
import { assertChecked } from "../../shared/contract/box-descriptor";
import { authoredContent, readContractInput, scenarioInput, type ScenarioResult } from "../../shared/contract/authoring";
import { builtInBoxes, serverBoxes } from "../box/registry";
import { AUTHORED_FILES, type AuthoredFile, type Candidate } from "./candidate";
import { runScenario } from "./scenario";

/** @approved The built-in sandboxed Boxes `read_contract` shows as examples, each by its source files. */
const examples = {
	mood: ["descriptor.json", "logic.ts"],
	race: ["descriptor.json", "logic.ts", "logic-engine.ts", "shared.ts", "shared-data.ts", "ui.ts", "ui-markup.ts", "ui.css"],
} as const;

const contract = Bun.file(join(import.meta.dir, "contract.md"));
const readContract = async ({ example }: { readonly example?: keyof typeof examples }) => example === undefined
	? await contract.text()
	: (await Promise.all(examples[example].map(async (file) => `--- ${example}/${file}\n${await Bun.file(join(builtInBoxes, example, file)).text()}`))).join("\n");

const content = (file: AuthoredFile) => authoredContent(`The whole of ${file}, at most ${AUTHORED_FILES[file] / 1024} KiB.`);
const writes = {
	write_descriptor: ["descriptor.json", "Replaces descriptor.json. The host sets its id."],
	write_logic: ["logic.js", "Replaces logic.js, the ES module default-exporting the Box's hooks."],
	write_ui: ["ui.js", "Replaces ui.js, the script that draws the Box's window in a Worker."],
	write_css: ["ui.css", "Replaces ui.css, the Box window's stylesheet."],
} as const satisfies Record<string, readonly [AuthoredFile, string]>;

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
// scenario's result under its tool call's id, for the panel.
export const authoringTools = (candidate: Candidate, { spend, onScenario }: { readonly spend: (signal: AbortSignal) => Promise<void>; readonly onScenario: (call: string, result: ScenarioResult) => void }) => {
	const tool = <Schema extends TSchema>(name: string, description: string, schema: Schema, execute: (input: Static<Schema>, call: string, signal: AbortSignal) => unknown) => ({
		name, description, idempotent: true, writes: true,
		inputSchema: JSON.parse(JSON.stringify(schema)),
		execute: async (input: unknown, { executionId, signal }: { readonly executionId: string; readonly signal: AbortSignal }) => {
			await spend(signal);
			assertChecked(schema, input, `The ${name} arguments`);
			return await execute(input, executionId, signal);
		},
	});
	return [
		tool("read_contract", "Returns the sandboxed Box contract. Read it before writing any file. With `example`, returns that built-in Box's sources instead.",
			readContractInput, readContract),
		...Object.entries(writes).map(([name, [file, description]]) => tool(name, description, content(file), ({ content: text }, _, signal) => candidate.write(file, text, signal))),
		tool("run_scenario", "Loads the Box from its files as the app would and plays the scenario against it, returning its diagnostics, prompt items, records, state and read or status.",
			scenarioInput, async (input, call, signal) => {
				const result = await candidate.check(() => runScenario(candidate.folder, candidate.id, new Set(serverBoxes().keys()), input, signal), signal);
				onScenario(call, result);
				return result;
			}),
	];
};
