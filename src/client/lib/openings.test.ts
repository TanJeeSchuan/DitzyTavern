import { describe, expect, test } from "bun:test";
Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://localhost" } } });
const { openingsFromText } = await import("../NewChatPanel");

describe("openingsFromText", () => {
	test("trims trailing whitespace and carriage returns", () => {
		expect(openingsFromText("Dawn shift  \r\n  Night watch\t\r\n\nDusk")).toEqual([
			"Dawn shift",
			"  Night watch",
			"",
			"Dusk",
		]);
	});

	test("keeps an empty textarea as no openings", () => {
		expect(openingsFromText("")).toEqual([]);
	});
});
