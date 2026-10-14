import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";

import { DEFAULT_CONVERSATION_GENERATION_SETTINGS } from "../../server/conversation";
import { canonicalGenerationSettings, type CanonicalGenerationSettings } from "./generation-settings";

const check = (overrides: Partial<CanonicalGenerationSettings>) =>
	Value.Check(canonicalGenerationSettings, { ...DEFAULT_CONVERSATION_GENERATION_SETTINGS, ...overrides });

describe("canonicalGenerationSettings", () => {
	test("accepts the default settings the server creates", () => {
		expect(Value.Check(canonicalGenerationSettings, DEFAULT_CONVERSATION_GENERATION_SETTINGS)).toBe(true);
	});

	test("requires non-blank model IDs and Continuation instructions while leaving trimming to the domain", () => {
		expect(check({ modelId: "  deepseek-chat  ", continuationInstruction: "  Keep writing.  " })).toBe(true);
		for (const blank of ["", "   ", "\t\n"]) {
			expect(check({ modelId: blank })).toBe(false);
			expect(check({ continuationInstruction: blank })).toBe(false);
		}
	});
});
