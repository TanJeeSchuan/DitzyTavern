import { describe, expect, test } from "bun:test";
import {
	budgetDraftsFromSettings,
	collidingSamplingOverrideKeys,
	makeEmptyBudgetDrafts,
	makeEmptyOverridesDrafts,
	makeEmptySamplingDrafts,
	managedOverrideKeys,
	overridesDraftsFromSettings,
	parseBudgetDraft,
	parseOverridesDraft,
	parseSamplingDraft,
	resolveBudgetValues,
	resolveOverridesValues,
	resolveSamplingValues,
	generationSettingsSummaryFromDrafts,
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

describe("request override drafts", () => {
	test("a plain JSON object parses as a valid namespace", () => {
		const parsed = parseOverridesDraft({
			custom_field: "kept",
			off: 0.5,
			nested: { list: [1, true, null] },
		});
		expect(parsed).toEqual({
			status: "valid",
			value: {
				custom_field: "kept",
				off: 0.5,
				nested: { list: [1, true, null] },
			},
		});
	});

	test("non-object and non-JSON drafts are invalid", () => {
		for (const candidate of [
			null,
			undefined,
			[],
			[1, 2],
			"text",
			42,
			true,
			() => undefined,
		]) {
			expect(parseOverridesDraft(candidate)).toEqual({ status: "invalid" });
		}
	});

	test("values that cannot serialize follow the server's JSON-value rule", () => {
		// JSON.stringify throws on BigInt, mirroring cloneRequestOverrides.
		expect(parseOverridesDraft({ big: 7n })).toEqual({ status: "invalid" });
		// JSON.stringify normalizes NaN to null exactly like the server copy.
		expect(parseOverridesDraft({ notANumber: Number.NaN })).toEqual({
			status: "valid",
			value: { notANumber: null },
		});
	});

	test("resolving drafts blocks on any invalid namespace", () => {
		const drafts = makeEmptyOverridesDrafts();
		expect(resolveOverridesValues(drafts)).toEqual({
			"chat-completions": {},
			responses: {},
			"anthropic-messages": {},
		});
		drafts.responses = ["not", "an", "object"];
		expect(resolveOverridesValues(drafts)).toBeNull();
	});

	test("stored overrides seed drafts and resolvers invert them exactly", () => {
		const drafts = overridesDraftsFromSettings({
			requestOverrides: {
				"chat-completions": { custom_field: "kept" },
				responses: {},
				"anthropic-messages": { max_tokens: "never" },
			},
		});
		expect(drafts).toEqual({
			"chat-completions": { custom_field: "kept" },
			responses: {},
			"anthropic-messages": { max_tokens: "never" },
		});
		expect(resolveOverridesValues(drafts)).toEqual({
			"chat-completions": { custom_field: "kept" },
			responses: {},
			"anthropic-messages": { max_tokens: "never" },
		});
	});

	test("collision detection matches the closed first-class Sampling key set", () => {
		expect(collidingSamplingOverrideKeys({})).toEqual([]);
		expect(
			collidingSamplingOverrideKeys({
				temperature: 0.7,
				top_p: 0.9,
				frequency_penalty: 0,
				presence_penalty: 0,
				custom_field: "kept",
			}),
		).toEqual(["temperature", "top_p", "frequency_penalty", "presence_penalty"]);
		expect(
			collidingSamplingOverrideKeys({ max_tokens: 10, custom_field: "kept" }),
		).toEqual([]);
	});

	test("managed keys are reported only in the Chat Completions namespace", () => {
		const overrides = {
			messages: [],
			model: "deepseek-chat",
			stream: false,
			n: 1,
			max_tokens: 10,
			max_completion_tokens: 10,
			custom_field: "kept",
		};
		expect(managedOverrideKeys("chat-completions", overrides)).toEqual({
			structural: ["messages", "model", "stream", "n"],
			outputLimit: ["max_tokens", "max_completion_tokens"],
		});
		expect(managedOverrideKeys("responses", overrides)).toEqual({
			structural: [],
			outputLimit: [],
		});
		expect(managedOverrideKeys("anthropic-messages", overrides)).toEqual({
			structural: [],
			outputLimit: [],
		});
	});

	test("managed keys are absent when the override does not use them", () => {
		expect(managedOverrideKeys("chat-completions", { custom_field: "kept" })).toEqual({
			structural: [],
			outputLimit: [],
		});
	});
});

describe("Generation Settings summaries", () => {
	test("derives compact summaries from the same drafts used for saving", () => {
		const sampling = makeEmptySamplingDrafts();
		sampling.temperature = "0.7";
		const budget = makeEmptyBudgetDrafts();
		budget.contextLimit = "32768";
		budget.responseBudget = "1024";
		budget.safetyAllowance = "500";
		budget.siblingGenerationLimit = "4";
		const overrides = makeEmptyOverridesDrafts();
		overrides["chat-completions"] = { custom_field: true };

		expect(generationSettingsSummaryFromDrafts({ sampling, budget, overrides }, "chat-completions")).toEqual({
			sampling: "1 value configured",
			budget: "32,768 context · 1,024 response",
			overrides: "1 custom field",
			transmittingNamespace: "Chat Completions",
		});
	});

	test("surfaces invalid drafts and an unavailable transmitting namespace", () => {
		const sampling = makeEmptySamplingDrafts();
		const budget = makeEmptyBudgetDrafts();
		const overrides = makeEmptyOverridesDrafts();
		budget.contextLimit = "not a number";

		expect(generationSettingsSummaryFromDrafts({ sampling, budget, overrides }, null)).toEqual({
			sampling: "Provider defaults",
			budget: "Fix invalid values",
			overrides: "No transmitted namespace",
			transmittingNamespace: "Unknown",
		});
	});
});
