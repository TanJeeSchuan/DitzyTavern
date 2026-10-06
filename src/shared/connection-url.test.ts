import { describe, expect, test } from "bun:test";
import { resolveRequestUrl } from "./connection-url";

describe("resolveRequestUrl", () => {
	test("appends the Chat Completions path only to base URLs", () => {
		expect(resolveRequestUrl("https://api.example.com/", "chat-completions")).toBe(
			"https://api.example.com/chat/completions",
		);
		expect(resolveRequestUrl("https://api.example.com/v1/", "chat-completions")).toBe(
			"https://api.example.com/v1/chat/completions",
		);
	});

	test("preserves exact request URLs, including nonstandard endpoints", () => {
		expect(resolveRequestUrl("https://api.example.com/v1", "chat-completions")).toBe(
			"https://api.example.com/v1",
		);
		expect(resolveRequestUrl("https://api.example.com/generate", "chat-completions")).toBe(
			"https://api.example.com/generate",
		);
		expect(
			resolveRequestUrl("https://api.example.com/v1/chat/completions", "chat-completions"),
		).toBe("https://api.example.com/v1/chat/completions");
	});

	test("trims input while preserving query parameters", () => {
		expect(resolveRequestUrl("  https://api.example.com/v1/?region=local  ", "chat-completions")).toBe(
			"https://api.example.com/v1/chat/completions?region=local",
		);
	});

	test("rejects unsupported schemes, user information, and fragments", () => {
		expect(() => resolveRequestUrl("file:///tmp/provider", "chat-completions"))
			.toThrow("must use HTTP or HTTPS");
		expect(() => resolveRequestUrl("https://user:secret@api.example.com/", "chat-completions"))
			.toThrow("must not contain user information or a fragment");
		expect(() => resolveRequestUrl("https://api.example.com/#credential", "chat-completions"))
			.toThrow("must not contain user information or a fragment");
	});
});
