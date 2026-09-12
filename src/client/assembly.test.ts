import { describe, expect, test } from "bun:test";
import { canStartAssembly } from "./assembly";

describe("assembly gate", () => {
	test("allows a playable idle conversation with no competing surface", () => {
		expect(canStartAssembly({
			playable: true,
			isGenerating: false,
			promptPlanOpen: false,
			promptPlanPending: false,
			variantPreviewActive: false,
		})).toBe(true);
	});

	test("refuses every competing state", () => {
		const base = {
			playable: true,
			isGenerating: false,
			promptPlanOpen: false,
			promptPlanPending: false,
			variantPreviewActive: false,
		};
		for (const blocked of [
			{ isGenerating: true },
			{ promptPlanOpen: true },
			{ promptPlanPending: true },
			{ variantPreviewActive: true },
			{ playable: false },
		]) {
			expect(canStartAssembly({ ...base, ...blocked })).toBe(false);
		}
	});
});
