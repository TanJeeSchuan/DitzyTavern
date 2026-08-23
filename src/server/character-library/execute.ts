import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import {
	characterOpeningTable,
	characterPromptTable,
	characterTable,
} from "../database/schema";
import { createCharacter } from "./create";
import {
	CharacterNotFoundError,
	StaleCharacterRevisionError,
} from "./errors";
import {
	connectCharacterLibraryDatabase,
	requireActiveCharacter,
	requireCommandName,
	requireCommandOpenings,
} from "./internal";
import { readCharacterSnapshot } from "./snapshot";
import type { CharacterLibraryCommand, CharacterSnapshot } from "./types";

// Executes one revisioned Character command atomically. Every mutation
// except creation requires the expected revision and increments it on
// success. A stale command fails without any change and carries the
// authoritative current Character in the typed conflict.
export function executeCharacterCommand(
	database: Database,
	command: CharacterLibraryCommand,
): CharacterSnapshot {
	if (command.type === "create") {
		return createCharacter(database, command.definition);
	}

	const db = connectCharacterLibraryDatabase(database);
	const execute = database.transaction(() => {
		const character = requireActiveCharacter(db, command.characterId);
		if (character.revision !== command.expectedRevision) {
			const current = readCharacterSnapshot(db, character.id);
			if (current === undefined) {
				throw new CharacterNotFoundError(command.characterId);
			}
			throw new StaleCharacterRevisionError(
				command.characterId,
				command.expectedRevision,
				character.revision,
				current,
			);
		}

		switch (command.type) {
			case "rename": {
				const name = requireCommandName(command.name);
				db.update(characterTable)
					.set({ name })
					.where(eq(characterTable.id, character.id))
					.run();
				break;
			}
			case "replace-prompt": {
				db.insert(characterPromptTable)
					.values({
						character_id: character.id,
						system_instruction: command.prompt.systemInstruction,
						identity: command.prompt.identity,
						scenario: command.prompt.scenario,
						example_dialogue: command.prompt.exampleDialogue,
						post_history_instruction: command.prompt.postHistoryInstruction,
					})
					.onConflictDoUpdate({
						target: characterPromptTable.character_id,
						set: {
							system_instruction: command.prompt.systemInstruction,
							identity: command.prompt.identity,
							scenario: command.prompt.scenario,
							example_dialogue: command.prompt.exampleDialogue,
							post_history_instruction: command.prompt.postHistoryInstruction,
						},
					})
					.run();
				break;
			}
			case "replace-openings": {
				const openings = requireCommandOpenings(command.openings);
				db.delete(characterOpeningTable)
					.where(eq(characterOpeningTable.character_id, character.id))
					.run();
				if (openings.length > 0) {
					db.insert(characterOpeningTable)
						.values(
							openings.map((content, index) => ({
								character_id: character.id,
								position: index + 1,
								content,
							})),
						)
						.run();
				}
				break;
			}
			case "set-pinned": {
				db.update(characterTable)
					.set({ pinned: command.pinned })
					.where(eq(characterTable.id, character.id))
					.run();
				break;
			}
		}

		const advanced = db
			.update(characterTable)
			.set({ revision: character.revision + 1 })
			.where(eq(characterTable.id, character.id))
			.returning({ id: characterTable.id })
			.get();
		if (advanced === undefined) {
			throw new CharacterNotFoundError(command.characterId);
		}

		const snapshot = readCharacterSnapshot(db, character.id);
		if (snapshot === undefined) {
			throw new CharacterNotFoundError(command.characterId);
		}
		return snapshot;
	});

	return execute.immediate();
}
