import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";

import { DEFAULT_CONVERSATION_GENERATION_SETTINGS } from "../../server/conversation/generation-settings";
import type { GenerationProvenanceSettings } from "../generation-provenance";
import {
	conversationGenerationSettings,
	generationProvenanceSettingsWire,
} from "./conversation-schema";
import {
	canonicalGenerationSettings,
	type CanonicalGenerationSettings,
} from "./generation-settings";

const validSettings = (): CanonicalGenerationSettings => ({
	modelId: "deepseek-chat",
	temperature: null,
	topP: null,
	frequencyPenalty: null,
	presencePenalty: null,
	contextLimit: 32768,
	responseBudget: 1024,
	safetyAllowance: 500,
	siblingGenerationLimit: 4,
	continuationStrategy: "instruction",
	continuationInstruction:
		"Continue the narrative naturally without repeating the previous text.",
	continuationPrefillSuffix: "",
	repeatedImagePlacement: "last",
	requestOverrides: {
		"chat-completions": {},
		responses: {},
		"anthropic-messages": {},
	},
});

// Removes one named field at runtime while keeping the fixture's named
// domain type; Value.Check reads the result as untrusted input anyway.
const withoutField = <K extends keyof CanonicalGenerationSettings>(
	settings: CanonicalGenerationSettings,
	field: K,
): Omit<CanonicalGenerationSettings, K> => {
	const { [field]: _omitted, ...rest } = settings;
	return rest;
};

describe("canonicalGenerationSettings", () => {
	test("accepts the default settings the server creates", () => {
		expect(Value.Check(canonicalGenerationSettings, DEFAULT_CONVERSATION_GENERATION_SETTINGS)).toBe(true);
	});

	test("accepts every currently valid setting", () => {
		const valid: readonly CanonicalGenerationSettings[] = [
			validSettings(),
			// Sampling boundaries: null means provider default, values are
			// finite and within [-2, 2].
			{ ...validSettings(), temperature: -2, topP: 0, frequencyPenalty: 2, presencePenalty: 1 },
			{ ...validSettings(), temperature: 2, topP: 1, frequencyPenalty: -2, presencePenalty: -1 },
			// Budget floors: every whole-number bound accepts its minimum and
			// the Safety allowance also accepts zero.
			{ ...validSettings(), contextLimit: 1, responseBudget: 1, safetyAllowance: 0, siblingGenerationLimit: 1 },
			// A model ID and instruction may carry whitespace around real
			// content; the owning domain trims, the declaration only requires
			// non-blank values.
			{ ...validSettings(), modelId: "  deepseek-chat  ", continuationInstruction: "  Keep writing.  " },
			{ ...validSettings(), continuationStrategy: "assistant-prefill", continuationPrefillSuffix: "\n\n" },
			{ ...validSettings(), continuationPrefillSuffix: " " },
			{ ...validSettings(), continuationPrefillSuffix: "\n" },
			// Request Overrides keep the full Generation JSON vocabulary in
			// each API Format namespace.
			{
				...validSettings(),
				requestOverrides: {
					"chat-completions": { temperature: 1, stop: ["\n\nHuman:", "\n\nAssistant:"], nested: { deep: [true, null, 0] } },
					responses: { max_output_tokens: 64, text: { verbosity: "low" } },
					"anthropic-messages": { top_k: 3, metadata: null },
				},
			},
		];
		for (const settings of valid) {
			expect(Value.Check(canonicalGenerationSettings, settings)).toBe(true);
		}
	});

	test("rejects invalid model values", () => {
		const withoutModelId = (({ modelId: _modelId, ...rest }: CanonicalGenerationSettings) => rest)(
			validSettings(),
		);
		const invalid: readonly unknown[] = [
			{ ...validSettings(), modelId: "" },
			{ ...validSettings(), modelId: "   " },
			{ ...validSettings(), modelId: "\t\n" },
			{ ...validSettings(), modelId: 42 },
			{ ...validSettings(), modelId: null },
			withoutModelId,
		];
		for (const settings of invalid) {
			expect(Value.Check(canonicalGenerationSettings, settings)).toBe(false);
		}
	});

	test("rejects invalid sampling values", () => {
		const invalidSampling: readonly unknown[] = [
			2.5,
			-2.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			"0.5",
			true,
		];
		for (const value of invalidSampling) {
			expect(Value.Check(canonicalGenerationSettings, { ...validSettings(), temperature: value })).toBe(false);
			expect(Value.Check(canonicalGenerationSettings, { ...validSettings(), topP: value })).toBe(false);
			expect(Value.Check(canonicalGenerationSettings, { ...validSettings(), frequencyPenalty: value })).toBe(false);
			expect(Value.Check(canonicalGenerationSettings, { ...validSettings(), presencePenalty: value })).toBe(false);
		}
	});

	test("rejects invalid budget values", () => {
		const nonPositive: readonly unknown[] = [0, -1, 1.5, Number.NaN, "4096", null];
		for (const value of nonPositive) {
			expect(Value.Check(canonicalGenerationSettings, { ...validSettings(), contextLimit: value })).toBe(false);
			expect(Value.Check(canonicalGenerationSettings, { ...validSettings(), responseBudget: value })).toBe(false);
			expect(Value.Check(canonicalGenerationSettings, { ...validSettings(), siblingGenerationLimit: value })).toBe(false);
		}
		// The Safety allowance is the only budget field that accepts zero.
		const invalidSafety: readonly unknown[] = [-1, 0.5, Number.NaN, "500", null];
		for (const value of invalidSafety) {
			expect(Value.Check(canonicalGenerationSettings, { ...validSettings(), safetyAllowance: value })).toBe(false);
		}
	});

	test("rejects invalid continuation values", () => {
		const invalidStrategies: readonly unknown[] = [
			"auto",
			"Instruction",
			"assistant prefill",
			"",
			null,
			7,
		];
		for (const value of invalidStrategies) {
			expect(Value.Check(canonicalGenerationSettings, { ...validSettings(), continuationStrategy: value })).toBe(false);
		}
		const invalidInstructions: readonly unknown[] = ["", "   ", "\t", 7, null];
		for (const value of invalidInstructions) {
			expect(Value.Check(canonicalGenerationSettings, { ...validSettings(), continuationInstruction: value })).toBe(false);
		}
		const invalidSuffixes: readonly unknown[] = ["\t", "\n ", "  ", " \n", "x", null, 7];
		for (const value of invalidSuffixes) {
			expect(Value.Check(canonicalGenerationSettings, { ...validSettings(), continuationPrefillSuffix: value })).toBe(false);
		}
	});

	test("rejects invalid Request Overrides values", () => {
		const base = validSettings();
		const invalid: readonly unknown[] = [
			{ ...base, requestOverrides: { responses: {}, "anthropic-messages": {} } },
			{ ...base, requestOverrides: { "chat-completions": {}, "anthropic-messages": {} } },
			{ ...base, requestOverrides: { "chat-completions": {}, responses: {} } },
			{ ...base, requestOverrides: { ...base.requestOverrides, "chat-completions": "stop sequences" } },
			{ ...base, requestOverrides: { ...base.requestOverrides, responses: 42 } },
			{ ...base, requestOverrides: { ...base.requestOverrides, "anthropic-messages": null } },
			{ ...base, requestOverrides: { ...base.requestOverrides, "anthropic-messages": ["not", "an", "object"] } },
			"overrides",
			42,
			null,
			withoutField(base, "requestOverrides"),
		];
		for (const settings of invalid) {
			expect(Value.Check(canonicalGenerationSettings, settings)).toBe(false);
		}
	});

});

describe("conversationGenerationSettings", () => {
	test("keeps the canonical validation semantics on the transport boundary", () => {
		const settings = { connectionProfileId: null, ...validSettings() };
		expect(Value.Check(conversationGenerationSettings, settings)).toBe(true);
		expect(Value.Check(conversationGenerationSettings, { ...settings, responseBudget: 0 })).toBe(false);
		expect(Value.Check(conversationGenerationSettings, { ...settings, continuationPrefillSuffix: "\t" })).toBe(false);
	});
});

describe("generationProvenanceSettingsWire", () => {
	test("accepts the captured provenance settings with their intentional nullability", () => {
		const settings = validSettings();
		const captured = {
			temperature: settings.temperature,
			topP: settings.topP,
			frequencyPenalty: settings.frequencyPenalty,
			presencePenalty: settings.presencePenalty,
			contextLimit: settings.contextLimit,
			responseBudget: settings.responseBudget,
			safetyAllowance: settings.safetyAllowance,
			siblingGenerationLimit: settings.siblingGenerationLimit,
			continuationStrategy: settings.continuationStrategy,
			continuationInstruction: settings.continuationInstruction,
			continuationPrefillSuffix: settings.continuationPrefillSuffix,
			repeatedImagePlacement: "last",
		} satisfies GenerationProvenanceSettings;
		expect(Value.Check(generationProvenanceSettingsWire, captured)).toBe(true);
		// Every retained field is nullable: an unconfigured value decodes as
		// null rather than an accidental zero or empty string.
		const allNull = Object.fromEntries(
			Object.keys(captured).map((field) => [field, null]),
		);
		expect(Value.Check(generationProvenanceSettingsWire, allNull)).toBe(true);
		// The wire kinds still reject wrong-typed values.
		expect(Value.Check(generationProvenanceSettingsWire, { ...allNull, temperature: "not-a-number" })).toBe(false);
		expect(Value.Check(generationProvenanceSettingsWire, { ...allNull, contextLimit: 2.5 })).toBe(false);
		expect(Value.Check(generationProvenanceSettingsWire, { ...allNull, continuationStrategy: "auto" })).toBe(false);
	});
});
