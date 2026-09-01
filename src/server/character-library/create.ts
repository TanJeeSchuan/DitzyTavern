import type { Database } from "bun:sqlite";
import {
	characterOpeningTable,
	characterPromptTable,
	characterTable,
} from "../database/schema";
import {
	connectCharacterLibraryDatabase,
	requireDefinition,
} from "./internal";
import { readCharacterSnapshot } from "./snapshot";
import type { CharacterDefinition, CharacterSnapshot } from "./types";

// ==[HUMAN APPROVED]== Creates one Character atomically from a complete Definition. Partially
// configured library entries cannot exist: the lifecycle row, its Prompt
// row, and all Opening rows commit together or not at all.
export function createCharacter(
	database: Database,
	definition: CharacterDefinition,
): CharacterSnapshot {
	const db = connectCharacterLibraryDatabase(database);
	const { name, openings } = requireDefinition(
		definition.name,
		definition.openings,
	);

	const create = database.transaction(() => {
		const inserted = db
			.insert(characterTable)
			.values({ name })
			.returning({ id: characterTable.id })
			.get();
		if (inserted === undefined) {
			throw new Error("Character creation did not return an identifier.");
		}

		db.insert(characterPromptTable)
			.values({
				character_id: inserted.id,
				system_instruction: definition.prompt.systemInstruction,
				identity: definition.prompt.identity,
				scenario: definition.prompt.scenario,
				example_dialogue: definition.prompt.exampleDialogue,
				post_history_instruction: definition.prompt.postHistoryInstruction,
			})
			.run();

		if (openings.length > 0) {
			db.insert(characterOpeningTable)
				.values(
					openings.map((content, index) => ({
						character_id: inserted.id,
						position: index + 1,
						content,
					})),
				)
				.run();
		}

		const snapshot = readCharacterSnapshot(db, inserted.id);
		if (snapshot === undefined) {
			throw new Error("Created Character could not be read back.");
		}
		return snapshot;
	});

	return create.immediate();
}
