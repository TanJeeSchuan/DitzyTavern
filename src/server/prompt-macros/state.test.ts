import { describe, expect, test } from "bun:test";
import {
	deriveMacroState,
	macroInitialValuesToData,
	macroWritesToData,
	readMacroWrites,
} from "./state";
import type { MacroValue } from "../../shared/prompt-macro-engine";

describe("Macro state persistence", () => {
	test("applies selected Variant writes in order while ignoring unselected siblings", () => {
		const initialData = macroInitialValuesToData(4, new Map<string, MacroValue>([["turn", 5], ["old", "kept"]]));
		const selected = macroWritesToData(4, [
			{ name: "turn", operation: "set", value: 6 },
			{ name: "old", operation: "delete", value: undefined },
		]);
		const unselected = macroWritesToData(4, [{ name: "turn", operation: "set", value: 99 }]);
		const state = deriveMacroState({
			initialData,
			presetId: 4,
			selectedVariants: [
				{ selected: true, data: selected },
				{ selected: false, data: unselected },
			],
		});
		expect(state).toEqual(new Map([["turn", 6]]));
		expect(readMacroWrites(selected, 4)).toEqual([
			{ name: "turn", operation: "set", value: 6 },
			{ name: "old", operation: "delete", value: undefined },
		]);
	});
});
