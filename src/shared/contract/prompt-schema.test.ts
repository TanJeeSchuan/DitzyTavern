import { describe, expect, test } from "bun:test";
import { characterSnapshot } from "./character-library";
import { conversationSummary } from "./conversation-schema";
import { participantPrompt } from "./prompt-schema";

describe("canonical prompt contract", () => {
	test("is the same five-field schema object in both contracts", () => {
		expect(characterSnapshot.properties.prompt).toBe(participantPrompt);
		expect(conversationSummary.properties.cast.items.properties.prompt).toBe(
			participantPrompt,
		);
		expect(Object.keys(participantPrompt.properties).sort()).toEqual([
			"exampleDialogue",
			"identity",
			"postHistoryInstruction",
			"scenario",
			"systemInstruction",
		]);
	});
});
