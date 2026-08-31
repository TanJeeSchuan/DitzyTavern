import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";

import { connectionProfileDraftSchema } from "./connection-settings";

const validDraft = {
	displayName: "DeepSeek",
	apiFormat: "chat-completions",
	requestUrl: "https://api.deepseek.com/",
	modelsUrl: "https://api.deepseek.com/models",
	modelBackend: "automatic",
	adapter: "deepseek",
	outputTokenRepresentation: "automatic",
	timeoutMs: 120000,
	pinnedModels: ["deepseek-chat"],
};

describe("connectionProfileDraftSchema", () => {
	test("accepts the canonical draft vocabulary", () => {
		expect(Value.Check(connectionProfileDraftSchema, validDraft)).toBe(true);
	});

	test("rejects the removed legacy Backend Options field at the wire boundary", () => {
		// The wire schema is the only gate: arbitrary Backend Options are a
		// structurally invalid draft, not a hidden domain-side rejection.
		expect(Value.Check(connectionProfileDraftSchema, {
			...validDraft,
			backendOptions: { temperature: 0.2 },
		})).toBe(false);
	});
});
