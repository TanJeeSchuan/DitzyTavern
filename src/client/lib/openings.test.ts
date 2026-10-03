import { describe, expect, test } from "bun:test";
import { openingsFromText } from "./openings";

// Characterizes the single openings conversion shared by New Chat, Cast,
// and Character Library editors. The trimming variant is the deliberate one
// (it replaced the Character Library's untrimmed duplicate), so these
// assertions pin the exact semantics: trailing whitespace and Windows
// carriage returns never leak into stored openings, while leading
// indentation and blank lines survive verbatim.
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
