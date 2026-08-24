import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createCharacterLibraryModule } from "../character-library";
import { openDatabase } from "../database/database";
import { createImportedConversation } from ".";

const definition = {
	name: "Vesper",
	prompt: {
		systemInstruction: "",
		identity: "A watchkeeper at the city gate.",
		scenario: "",
		exampleDialogue: "",
		postHistoryInstruction: "",
	},
	openings: [],
};

describe("Chat Import workflow", () => {
	let database: Database;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
	});

	afterEach(() => {
		database.close();
	});

	test("creates a requested Character and the Conversation together", () => {
		const conversation = createImportedConversation(database, {
			name: "Imported watch",
			participants: [{ definition, createCharacter: true }],
			control: { human: 0 },
		});

		const participant = conversation.cast[0];
		expect(participant?.name).toBe("Vesper");
		expect(participant?.sourceCharacterId).not.toBeNull();
		expect(
			createCharacterLibraryModule(database).get(
				participant?.sourceCharacterId ?? -1,
			),
		).toMatchObject({ name: "Vesper", prompt: definition.prompt });
	});
});
