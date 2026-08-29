import { describe, expect, test } from "bun:test";
import { openingsFromText, openingsToText } from "./openings";

// Characterizes the single openings conversion shared by the Cast and
// Character Library editors. The trimming variant is the deliberate one
// (it replaced the Character Library's untrimmed duplicate), so these
// assertions pin the exact semantics: trailing whitespace and Windows
// carriage returns never leak into stored openings, while leading
// indentation and blank lines survive verbatim.
describe("openingsFromText", () => {
	test("splits lines and trims only their ends", () => {
		expect(openingsFromText("Dawn shift\r\n  Night watch \n\nDusk")).toEqual([
			"Dawn shift",
			"  Night watch",
			"",
			"Dusk",
		]);
	});

	test("keeps an empty textarea as one empty opening", () => {
		expect(openingsFromText("")).toEqual([""]);
	});
});

describe("openingsToText", () => {
	test("joins openings with textarea line breaks", () => {
		expect(openingsToText(["Dawn shift", "", "Night watch"])).toBe(
			"Dawn shift\n\nNight watch",
		);
	});
});
