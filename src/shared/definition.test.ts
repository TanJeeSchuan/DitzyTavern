import { describe, expect, test } from "bun:test";
import { firstPromptText, promptPreview } from "./definition";

const emptyPrompt = () => ({
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
});

describe("firstPromptText", () => {
	test("returns the first non-empty field in presentation order", () => {
		expect(
			firstPromptText({
				...emptyPrompt(),
				scenario: "A storm season.",
				identity: "Lighthouse archivist.",
			}),
		).toBe("Lighthouse archivist.");
		expect(
			firstPromptText({ ...emptyPrompt(), identity: "Lighthouse archivist." }),
		).toBe("Lighthouse archivist.");
	});

	test("returns an empty string when every field is blank", () => {
		expect(firstPromptText(emptyPrompt())).toBe("");
	});

	test("treats whitespace-only fields as empty", () => {
		expect(
			firstPromptText({ ...emptyPrompt(), systemInstruction: "   " }),
		).toBe("");
	});
});

describe("promptPreview", () => {
	test("keeps short text exactly and truncates longer text with an ellipsis", () => {
		expect(promptPreview("Short.")).toBe("Short.");
		const long = "a".repeat(200);
		expect(promptPreview(long)).toBe(`${"a".repeat(140)}…`);
	});

	test("trims surrounding whitespace and falls back for blank text", () => {
		expect(promptPreview("  text  ")).toBe("text");
		expect(promptPreview("   ")).toBe("No prompt text yet.");
	});
});