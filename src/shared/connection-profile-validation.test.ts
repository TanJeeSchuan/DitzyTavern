import { describe, expect, test } from "bun:test";
import {
	validateConnectionProfileHeaderNames,
	validateConnectionProfileShared,
	validateConnectionProfileSharedDraft,
	type SharedConnectionProfileDraft,
} from "./connection-profile-validation";

const validDraft = (): SharedConnectionProfileDraft => ({
	apiFormat: "chat-completions",
	modelBackend: "automatic",
	adapter: "openai-compatible",
	outputTokenRepresentation: "automatic",
	requestUrl: "https://api.example.com/v1/",
	modelsUrl: "https://api.example.com/models",
	timeoutMs: 120000,
});

describe("validateConnectionProfileSharedDraft", () => {
	test("accepts a fully valid draft and blank optional URLs", () => {
		expect(validateConnectionProfileSharedDraft(validDraft())).toBeNull();
		expect(
			validateConnectionProfileSharedDraft({ ...validDraft(), requestUrl: "  ", modelsUrl: "" }),
		).toBeNull();
		expect(
			validateConnectionProfileSharedDraft({ ...validDraft(), timeoutMs: null }),
		).toBeNull();
		expect(
			validateConnectionProfileSharedDraft({ ...validDraft(), timeoutMs: 0 }),
		).toBeNull();
	});

	test("rejects unsupported enumerations with the current messages", () => {
		expect(
			validateConnectionProfileSharedDraft({ ...validDraft(), apiFormat: "responses" })?.message,
		).toBe("Only the Chat Completions API Format is available in version one.");
		expect(
			validateConnectionProfileSharedDraft({ ...validDraft(), modelBackend: "native" })?.message,
		).toBe("The selected Model Backend is unavailable.");
		expect(
			validateConnectionProfileSharedDraft({ ...validDraft(), adapter: "unknown" })?.message,
		).toBe("The selected AI SDK Adapter is unavailable.");
		expect(
			validateConnectionProfileSharedDraft({ ...validDraft(), outputTokenRepresentation: "tokens" })
				?.message,
		).toBe("The selected output-token representation is unavailable.");
	});

	test("rejects malformed and non-HTTP URLs", () => {
		expect(
			validateConnectionProfileSharedDraft({ ...validDraft(), requestUrl: "ftp://provider.test/" }),
		).toMatchObject({ field: "requestUrl" });
		expect(
			validateConnectionProfileSharedDraft({ ...validDraft(), requestUrl: "not a url" })?.message,
		).toBe("The request URL must be a valid HTTP or HTTPS URL.");
		expect(
			validateConnectionProfileSharedDraft({
				...validDraft(),
				modelsUrl: "https://user:secret@api.example.com/models",
			})?.message,
		).toBe("Models URL must use HTTP or HTTPS without user information or a fragment.");
		expect(
			validateConnectionProfileSharedDraft({
				...validDraft(),
				requestUrl: "https://api.example.com/#credential",
			})?.message,
		).toBe("request URL must use HTTP or HTTPS without user information or a fragment.");
	});

	test("rejects negative and non-integer timeouts", () => {
		expect(
			validateConnectionProfileSharedDraft({ ...validDraft(), timeoutMs: -1 })?.message,
		).toBe("Timeout must be zero, null, or a positive whole number of milliseconds.");
		expect(
			validateConnectionProfileSharedDraft({ ...validDraft(), timeoutMs: 1.5 })?.message,
		).toBe("Timeout must be zero, null, or a positive whole number of milliseconds.");
	});

	test("reports the first failure in the existing precedence order", () => {
		const failure = validateConnectionProfileSharedDraft({
			...validDraft(),
			apiFormat: "responses",
			modelBackend: "native",
			requestUrl: "not a url",
			timeoutMs: -1,
		});
		expect(failure?.field).toBe("apiFormat");
	});
});

describe("validateConnectionProfileHeaderNames", () => {
	test("accepts valid distinct headers", () => {
		expect(validateConnectionProfileHeaderNames([])).toBeNull();
		expect(validateConnectionProfileHeaderNames(["X-Route", "X-Auth"])).toBeNull();
	});

	test("rejects malformed and transport-owned names", () => {
		expect(validateConnectionProfileHeaderNames(["X One"])?.message).toBe(
			'Custom header name "X One" is not a valid user-controlled HTTP header.',
		);
		expect(validateConnectionProfileHeaderNames(["Host"])?.message).toBe(
			'Custom header name "Host" is not a valid user-controlled HTTP header.',
		);
		expect(validateConnectionProfileHeaderNames(["content-length"])?.message).toBe(
			'Custom header name "content-length" is not a valid user-controlled HTTP header.',
		);
	});

	test("rejects case-insensitive duplicates", () => {
		expect(validateConnectionProfileHeaderNames(["X-Route", "x-route"])?.message).toBe(
			'Custom header names must be unique case-insensitively: "x-route".',
		);
	});
});

describe("validateConnectionProfileShared", () => {
	test("validates draft rules before header names", () => {
		const failure = validateConnectionProfileShared(
			{ ...validDraft(), apiFormat: "responses" },
			["X One"],
		);
		expect(failure?.field).toBe("apiFormat");
		expect(
			validateConnectionProfileShared(validDraft(), ["X One"])?.field,
		).toBe("header");
		expect(validateConnectionProfileShared(validDraft(), ["X-Route"])).toBeNull();
	});
});
