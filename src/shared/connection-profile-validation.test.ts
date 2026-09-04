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
	test("keeps client and server rules for URLs, timeouts, and API availability in one order", () => {
		expect(sharedConnectionProfileValidationError(validDraft(), [])).toBeNull();
		expect(
			sharedConnectionProfileValidationError(
				{ ...validDraft(), apiFormat: "responses", requestUrl: "not a url" },
				[],
			),
		).toBe("Only the Chat Completions API Format is available in version one.");
		expect(
			sharedConnectionProfileValidationError({ ...validDraft(), requestUrl: "not a url" }, []),
		).toBe("The request URL must be a valid HTTP or HTTPS URL.");
		expect(
			sharedConnectionProfileValidationError(
				{ ...validDraft(), modelsUrl: "https://user:secret@api.example.com/models" },
				[],
			),
		).toBe("Models URL must use HTTP or HTTPS without user information or a fragment.");
		expect(
			sharedConnectionProfileValidationError({ ...validDraft(), timeoutMs: 1.5 }, []),
		).toBe("Timeout must be zero, null, or a positive whole number of milliseconds.");
	});

	test("rejects transport-owned and duplicate header names", () => {
		expect(sharedConnectionHeaderNamesValidationError(["Host"])).toBe(
			'Custom header name "Host" is not a valid user-controlled HTTP header.',
		);
		expect(sharedConnectionHeaderNamesValidationError(["X One"])).toBe(
			'Custom header name "X One" is not a valid user-controlled HTTP header.',
		);
		expect(sharedConnectionHeaderNamesValidationError(["X-Route", "x-route"])).toBe(
			'Custom header names must be unique case-insensitively: "x-route".',
		);
	});
});
