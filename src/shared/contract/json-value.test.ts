import { expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { canonicalGenerationSettings } from "./generation-settings";

test("Request Override values reject non-JSON values, including nested values", () => {
	const schema = canonicalGenerationSettings.properties.requestOverrides;
	for (const value of [() => 1, Infinity, NaN, new Map()]) {
		expect(Value.Check(schema, { "chat-completions": { nested: [value] }, responses: {}, "anthropic-messages": {} })).toBe(false);
	}
});
