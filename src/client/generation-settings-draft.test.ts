import { describe, expect, test } from "bun:test";
import {
	budgetDraftsFromSettings,
	makeEmptyBudgetDrafts,
	makeEmptySamplingDrafts,
	parseBudgetDraft,
	parseSamplingDraft,
	resolveBudgetValues,
	resolveSamplingValues,
	samplingDraftsFromSettings,
} from "./generation-settings-draft";

describe("sampling drafts", () => {
	test("blank text represents the provider default", () => {
		expect(parseSamplingDraft("")).toEqual({ status: "empty" });
		expect(parseSamplingDraft("   ")).toEqual({ status: "empty" });
	});

	test("values inside the server range stay valid at both boundaries", () => {
		for (const candidate of ["1", "1.5", "-2", "2", "-1.25"]) {
			expect(parseSamplingDraft(candidate)).toEqual({
				status: "valid",
				value: Number(candidate),
			});
			expect(parseSamplingDraft(`  ${candidate}  `)).toEqual({
				status: "valid",
				value: Number(candidate),
			});
		}
	});

	test("non-numeric and out-of-range text are invalid", () => {
		expect(parseSamplingDraft("warm")).toEqual({ status: "invalid" });
		expect(parseSamplingDraft("2.01")).toEqual({ status: "invalid" });
		expect(parseSamplingDraft("-2.01")).toEqual({ status: "invalid" });
		expect(parseSamplingDraft("NaN")).toEqual({ status: "invalid" });
		expect(parseSamplingDraft("Infinity")).toEqual({ status: "invalid" });
	});

	test("resolving drafts produces nullable values and blocks on any invalid field", () => {
		const drafts = makeEmptySamplingDrafts();
		drafts.temperature = "0.7";
		drafts.topP = "  ";
		expect(resolveSamplingValues(drafts)).toEqual({
			temperature: 0.7,
			topP: null,
			frequencyPenalty: null,
			presencePenalty: null,
		});
		drafts.frequencyPenalty = "3";
		expect(resolveSamplingValues(drafts)).toBeNull();
	});

	test("stored settings seed drafts and resolvers invert them exactly", () => {
		const drafts = samplingDraftsFromSettings({
			temperature: 0.7,
			topP: null,
			frequencyPenalty: -0.5,
			presencePenalty: null,
		});
		expect(drafts).toEqual({
			temperature: "0.7",
			topP: "",
			frequencyPenalty: "-0.5",
			presencePenalty: "",
		});
		expect(resolveSamplingValues(drafts)).toEqual({
			temperature: 0.7,
			topP: null,
			frequencyPenalty: -0.5,
			presencePenalty: null,
		});
	});
});

describe("budget drafts", () => {
	test("positive whole numbers parse at and above one", () => {
		for (const field of ["contextLimit", "responseBudget", "safetyAllowance", "siblingGenerationLimit"] as const) {
			for (const candidate of ["1", "2", "500", "32768", " 4096 "]) {
				expect(parseBudgetDraft(field, candidate)).toEqual({
					status: "valid",
					value: Number(candidate),
				});
			}
		}
	});

	test("Safety allowance alone accepts zero", () => {
		expect(parseBudgetDraft("safetyAllowance", "0")).toEqual({ status: "valid", value: 0 });
		for (const field of ["contextLimit", "responseBudget", "siblingGenerationLimit"] as const) {
			expect(parseBudgetDraft(field, "0")).toEqual({ status: "invalid" });
		}
	});

	test("negative values are rejected on every field", () => {
		for (const field of ["contextLimit", "responseBudget", "safetyAllowance", "siblingGenerationLimit"] as const) {
			expect(parseBudgetDraft(field, "-1")).toEqual({ status: "invalid" });
			expect(parseBudgetDraft(field, "-0")).toEqual({ status: "invalid" });
		}
	});

	test("non-whole numbers, blanks, and non-numeric text are invalid", () => {
		for (const field of ["contextLimit", "responseBudget", "safetyAllowance", "siblingGenerationLimit"] as const) {
			for (const candidate of ["", "   ", "1.5", "2.0", "0.1", "NaN", "Infinity", "-Infinity", "many", "1e3", "0x10", "1_000", "+"] as const) {
				expect(parseBudgetDraft(field, candidate)).toEqual({ status: "invalid" });
			}
		}
	});

	test("resolving drafts produces concrete values and blocks on any invalid field", () => {
		const drafts = makeEmptyBudgetDrafts();
		drafts.contextLimit = "32768";
		drafts.responseBudget = "1024";
		expect(resolveBudgetValues(drafts)).toBeNull();
		drafts.safetyAllowance = "500";
		drafts.siblingGenerationLimit = "4";
		expect(resolveBudgetValues(drafts)).toEqual({
			contextLimit: 32768,
			responseBudget: 1024,
			safetyAllowance: 500,
			siblingGenerationLimit: 4,
		});
		drafts.siblingGenerationLimit = "-2";
		expect(resolveBudgetValues(drafts)).toBeNull();
	});

	test("stored budget settings seed drafts and resolvers invert them exactly", () => {
		const drafts = budgetDraftsFromSettings({
			contextLimit: 8192,
			responseBudget: 256,
			safetyAllowance: 0,
			siblingGenerationLimit: 3,
		});
		expect(drafts).toEqual({
			contextLimit: "8192",
			responseBudget: "256",
			safetyAllowance: "0",
			siblingGenerationLimit: "3",
		});
		expect(resolveBudgetValues(drafts)).toEqual({
			contextLimit: 8192,
			responseBudget: 256,
			safetyAllowance: 0,
			siblingGenerationLimit: 3,
		});
	});
});
