import { describe, expect, test } from "bun:test";
import { resolveChatCompletionsRequestUrl } from "./connection-url";

describe("resolveChatCompletionsRequestUrl", () => {
	test("appends the Chat Completions path only to base URLs", () => {
		expect(resolveChatCompletionsRequestUrl("https://api.example.com/")).toBe(
			"https://api.example.com/chat/completions",
		);
		expect(resolveChatCompletionsRequestUrl("https://api.example.com/v1/")).toBe(
			"https://api.example.com/v1/chat/completions",
		);
	});

	test("preserves exact request URLs, including nonstandard endpoints", () => {
		expect(resolveChatCompletionsRequestUrl("https://api.example.com/v1")).toBe(
			"https://api.example.com/v1",
		);
		expect(resolveChatCompletionsRequestUrl("https://api.example.com/generate")).toBe(
			"https://api.example.com/generate",
		);
		expect(
			resolveChatCompletionsRequestUrl("https://api.example.com/v1/chat/completions"),
		).toBe("https://api.example.com/v1/chat/completions");
	});

	test("trims input while preserving query parameters", () => {
		expect(resolveChatCompletionsRequestUrl("  https://api.example.com/v1/?region=local  ")).toBe(
			"https://api.example.com/v1/chat/completions?region=local",
		);
	});

	test("rejects unsupported schemes, user information, and fragments", () => {
		expect(() => resolveChatCompletionsRequestUrl("file:///tmp/provider"))
			.toThrow("must use HTTP or HTTPS");
		expect(() => resolveChatCompletionsRequestUrl("https://user:secret@api.example.com/"))
			.toThrow("must not contain user information or a fragment");
		expect(() => resolveChatCompletionsRequestUrl("https://api.example.com/#credential"))
			.toThrow("must not contain user information or a fragment");
	});
});
