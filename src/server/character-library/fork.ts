import type { Database } from "bun:sqlite";
import { CharacterNotFoundError } from "./errors";
import { guardRevision } from "../revision";
import { connectCharacterLibraryDatabase } from "./internal";
import { readCharacterSnapshot } from "./snapshot";
import type { CharacterDefinition } from "./types";

// @approved
//  One fork of a Library Character: the authoritative Definition copied at
// the verified revision, plus the immutable provenance the copy carries.
export interface CharacterFork {
	readonly definition: CharacterDefinition;
	readonly sourceCharacterId: number;
}

/** @approved
 * The Library owns validating its own revision. Callers that copy a
 * Character into a Conversation state the revision they read; the Library
 * refuses a stale one and otherwise projects the Definition to copy together
 * with the source Character it must record as provenance.
 */
export function forkCharacter(
	database: Database,
	characterId: number,
	expectedRevision: number,
): CharacterFork {
	const character = readCharacterSnapshot(
		connectCharacterLibraryDatabase(database),
		characterId,
	);
	if (character === undefined) throw new CharacterNotFoundError(characterId);
	guardRevision("character", expectedRevision, character, () => character);
	return {
		definition: {
			name: character.name,
			prompt: character.prompt,
			openings: character.openings,
			portrait: character.portrait,
		},
		sourceCharacterId: character.id,
	};
}
