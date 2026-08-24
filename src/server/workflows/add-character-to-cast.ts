// Add Character to Cast workflow.
//
// Composes the Character Library and Conversation seams in one transaction:
// the source Character must match its expected revision and the destination
// Conversation its expected revision. The authoritative Character Definition
// is copied server-side into a new appended Participant with immutable
// provenance; a stale client-submitted Definition can never become the fork
// source. Either conflict fails atomically with no partial writes.

import type { Database } from "bun:sqlite";
import {
	CharacterNotFoundError,
	StaleCharacterRevisionError,
	withCharacterLibrary,
} from "../character-library";
import { createConversationModule } from "../conversation";
import type { ConversationSnapshot } from "../conversation/types";

export interface AddCharacterToCastInput {
	conversationId: number;
	expectedConversationRevision: number;
	characterId: number;
	expectedCharacterRevision: number;
}

export function addCharacterToCast(
	database: Database,
	input: AddCharacterToCastInput,
): ConversationSnapshot {
	const add = database.transaction(() => {
		const character = withCharacterLibrary(database, (library) =>
			library.get(input.characterId),
		);
		if (character === undefined) {
			throw new CharacterNotFoundError(input.characterId);
		}
		if (character.revision !== input.expectedCharacterRevision) {
			throw new StaleCharacterRevisionError(
				character.id,
				input.expectedCharacterRevision,
				character.revision,
				character,
			);
		}

		// The deep Conversation command validates the destination revision
		// and existence inside the same transaction; appending a fork copies
		// the authoritative server-side Definition just read from the Library
		// and records immutable provenance.
		return createConversationModule(database).execute({
			conversationId: input.conversationId,
			expectedRevision: input.expectedConversationRevision,
			action: {
				type: "add-participant",
				definition: {
					name: character.name,
					prompt: character.prompt,
					openings: character.openings,
				},
				sourceCharacterId: character.id,
			},
		});
	});

	return add.immediate();
}