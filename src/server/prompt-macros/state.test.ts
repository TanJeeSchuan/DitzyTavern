import { describe, expect, test } from "bun:test";
import {
	deriveMacroState,
	macroInitialValuesToData,
	macroWritesToData,
	readMacroWrites,
} from "./state";
import { variantDataCodecs } from "../../shared/variant-data-codecs";
import type { MacroValue } from "../../shared/prompt-macro-engine";

const decodedRecords = (entries: readonly { key: string; value: string }[]) =>
	entries.map((entry) => ({ key: entry.key, writes: variantDataCodecs.macroWrites.decodeOptional(entry.value) ?? [] }));

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
				{ selected: true, macroWrites: decodedRecords(selected) },
				{ selected: false, macroWrites: decodedRecords(unselected) },
			],
		});
		expect(state).toEqual(new Map([["turn", 6]]));
		expect(readMacroWrites(decodedRecords(selected), 4)).toEqual([
			{ name: "turn", operation: "set", value: 6 },
			{ name: "old", operation: "delete", value: undefined },
		]);
	});

	test("compacts durable writes to each variable's final assignment or deletion", () => {
		expect(readMacroWrites(decodedRecords(macroWritesToData(4, [
			{ name: "long", operation: "set", value: "obsolete" },
			{ name: "other", operation: "set", value: true },
			{ name: "long", operation: "delete", value: undefined },
		])), 4)).toEqual([
			{ name: "long", operation: "delete", value: undefined },
			{ name: "other", operation: "set", value: true },
		]);
	});
});
