import { portraitRow } from "../image";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import {
	characterOpeningTable,
	characterPromptTable,
	characterTable,
	toPromptChannelRow,
} from "../database/schema";
import { createCharacter } from "./create";
import { deleteCharacter } from "./delete-character";
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
import type {
	CharacterDeletionResult,
	CharacterCommand,
	CharacterSnapshot,
} from "./types";

// @approved
//  Executes one revisioned Character command atomically. Every mutation
// except creation requires the expected revision and increments it on
// success. A stale command fails without any change and carries the
// authoritative current Character in the typed conflict. Deletion returns
// the typed deletion result instead of a snapshot: an unreferenced
// Character is hard-deleted, a referenced one becomes a hidden
// nonrestorable tombstone, and neither remains readable through the seam.
export function executeCharacterCommand(
	database: Database,
	command: CharacterCommand,
): CharacterSnapshot | CharacterDeletionResult {
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

		if (command.type === "delete") {
			// @approved
			//  Deletion advances no further revision: a hard-deleted Character
			// has no row left, and a tombstone is hidden and nonrestorable.
			return deleteCharacter(db, command.characterId);
		}

		switch (command.type) {
			case "update-definition": {
				const name = requireCommandName(command.definition.name);
				const openings = requireCommandOpenings(command.definition.openings);
				db.update(characterTable).set({ name }).where(eq(characterTable.id, character.id)).run();
				const promptRow = { ...toPromptChannelRow(command.definition.prompt), ...portraitRow(db, command.definition.portrait) };
				db.insert(characterPromptTable).values({ character_id: character.id, ...promptRow })
					.onConflictDoUpdate({ target: characterPromptTable.character_id, set: promptRow }).run();
				db.delete(characterOpeningTable).where(eq(characterOpeningTable.character_id, character.id)).run();
				if (openings.length > 0) db.insert(characterOpeningTable).values(openings.map((content, index) => ({ character_id: character.id, position: index + 1, content }))).run();
				break;
			}
			case "rename": {
				const name = requireCommandName(command.name);
				db.update(characterTable)
					.set({ name })
					.where(eq(characterTable.id, character.id))
					.run();
				break;
			}
			case "replace-prompt": {
				const promptRow = toPromptChannelRow(command.prompt);
				db.insert(characterPromptTable)
					.values({
						character_id: character.id,
						...promptRow,
					})
					.onConflictDoUpdate({
						target: characterPromptTable.character_id,
						set: promptRow,
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
