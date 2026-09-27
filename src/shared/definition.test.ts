import { describe, expect, test } from "bun:test";
import { promptPreview } from "./definition";

describe("promptPreview", () => {
	test("keeps short text exactly and truncates longer text with an ellipsis", () => {
		expect(promptPreview("Short.")).toBe("Short.");
		const long = "a".repeat(200);
		expect(promptPreview(long)).toBe(`${"a".repeat(140)}…`);
	});

	test("trims surrounding whitespace and returns nothing for blank text", () => {
		expect(promptPreview("  text  ")).toBe("text");
		expect(promptPreview("   ")).toBe("");
	});
});
