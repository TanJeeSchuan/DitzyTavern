import { describe, expect, test } from "bun:test";
import type { ConnectionProfileDraft } from "./connection-settings";
import { connectionDraftValidationError } from "./connection-settings-draft";

const draft = (overrides: Partial<ConnectionProfileDraft> = {}): ConnectionProfileDraft => ({
	displayName: "Local",
	apiFormat: "chat-completions",
	requestUrl: "https://example.com/v1/",
	modelsUrl: "",
	modelBackend: "automatic",
	adapter: "openai-compatible",
	outputTokenRepresentation: "automatic",
	timeoutMs: 120000,
	pinnedModels: ["model"],
	...overrides,
});

describe("Connection Profile draft validation", () => {
	test("accepts a complete draft and optional blank URLs", () => {
		expect(connectionDraftValidationError(draft(), {})).toBeNull();
		expect(connectionDraftValidationError(draft({ requestUrl: "" }), {})).toBeNull();
	});

	test("blocks invalid advanced fields before Test or Save can send", () => {
		expect(connectionDraftValidationError(draft({ requestUrl: "not a URL" }), {})).toContain("request URL");
		expect(connectionDraftValidationError(draft({ timeoutMs: -1 }), {})).toContain("Timeout");
		expect(connectionDraftValidationError(draft(), {
		"Content-Type": { configured: false, operation: "replace", replacement: "json" },
	})).toContain("not a valid user-controlled");
	});
});
