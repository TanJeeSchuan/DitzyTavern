import { describe, expect, test } from "bun:test";
import { commitModelId, modelSuggestions, togglePinnedModel } from "./model-selection";

describe("model selection state", () => {
	test("shows pins in star order before a query and the full catalog while searching", () => {
		const input = {
			query: "",
			pinnedModels: ["custom-model", "Alpha"],
			discoveryCatalog: ["Alpha", "beta", "custom-model", "zeta"],
		};
		expect(modelSuggestions(input)).toEqual(["custom-model", "Alpha"]);
		expect(modelSuggestions({ ...input, query: "BE" })).toEqual(["beta"]);
		expect(modelSuggestions({ ...input, query: "custom" })).toEqual(["custom-model"]);
		expect(modelSuggestions({ ...input, query: "  local/model  " })).toEqual(["local/model"]);
	});

	test("keeps arbitrary free text separate from pinning and re-starring appends", () => {
		expect(commitModelId("  local/model  ")).toBe("local/model");
		expect(commitModelId("   ")).toBeNull();
		expect(togglePinnedModel(["first", "second"], "second")).toEqual(["first"]);
		expect(togglePinnedModel(["first"], "second")).toEqual(["first", "second"]);
		expect(togglePinnedModel(["second"], "first")).toEqual(["second", "first"]);
	});
});
