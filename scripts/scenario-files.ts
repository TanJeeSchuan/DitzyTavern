import { Value } from "@sinclair/typebox/value";
import { scenarioInput, type ScenarioInput } from "../src/shared/contract/authoring";

/** @approved Prints `message` and exits 2, the code the Box CLIs give for wrong arguments or files. */
export function usageError(message: string): never {
	console.error(message);
	process.exit(2);
}

/** @approved Reads each scenario file, exiting 2 on the first that isn't readable JSON or isn't a scenario, naming its bad fields. */
export const readScenarios = async (files: readonly string[]): Promise<ScenarioInput[]> => {
	const scenarios: ScenarioInput[] = [];
	for (const file of files) {
		let parsed: unknown;
		try {
			parsed = await Bun.file(file).json();
		} catch (error) {
			usageError(`${file} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		const errors = [...Value.Errors(scenarioInput, parsed)].slice(0, 5).map(({ path, message }) => `  ${path || "/"}: ${message}`);
		if (errors.length > 0) usageError(`${file} is not a scenario:\n${errors.join("\n")}`);
		scenarios.push(Value.Decode(scenarioInput, parsed));
	}
	return scenarios;
};
