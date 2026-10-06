import { describe, expect, test } from "bun:test";
import type { ConnectionProfileDraftPayload } from "./contract/connection-settings";
import {
	sharedConnectionHeaderNamesValidationError,
	sharedConnectionProfileValidationError,
} from "./connection-profile-validation";

const validDraft = (): ConnectionProfileDraftPayload => ({
	displayName: "Example",
	apiFormat: "chat-completions",
	modelBackend: "automatic",
	adapter: "openai-compatible",
	outputTokenRepresentation: "automatic",
	requestUrl: "https://api.example.com/v1/",
	modelsUrl: "https://api.example.com/models",
	timeoutMs: 120000,
	pinnedModels: [],
});

describe("shared Connection Profile validation", () => {
	test("rejects unavailable API Formats, invalid URLs, and fractional timeouts", () => {
		expect(sharedConnectionProfileValidationError(validDraft(), [])).toBeNull();
		for (const draft of [
			{ ...validDraft(), apiFormat: "responses" as const },
			{ ...validDraft(), requestUrl: "not a url" },
			{ ...validDraft(), modelsUrl: "https://user:secret@api.example.com/models" },
			{ ...validDraft(), timeoutMs: 1.5 },
		]) expect(sharedConnectionProfileValidationError(draft, [])).not.toBeNull();
	});

	test("rejects transport-owned and duplicate header names", () => {
		for (const names of [["Host"], ["X One"], ["X-Route", "x-route"]]) expect(sharedConnectionHeaderNamesValidationError(names)).not.toBeNull();
	});
});
