// ==[HUMAN APPROVED]== Add Character to Cast workflow.
//
// Composes the Character Library and Conversation seams in one transaction:
// the source Character must match its expected revision and the destination
// Conversation its expected revision. The authoritative Character Definition
// is copied server-side into a new appended Participant with immutable
// provenance; a stale client-submitted Definition can never become the fork
// source. Either conflict fails atomically with no partial writes.

import type { Database } from "bun:sqlite";
import type { Static } from "@sinclair/typebox";
import { forkCharacter } from "../character-library";
import { createConversationModule } from "../conversation";
import type { ConversationSnapshot } from "../conversation/types";
import { addCharacterToCastBody } from "../../shared/contract/conversation-schema";

// ==[HUMAN APPROVED]== The input derives from the canonical add-character-to-cast wire
// schema (ADR-0032) so the workflow can never drift from the transport
// contract; the Conversation id is not part of the body because it lives in
// the route path.
export type AddCharacterToCastInput = Static<typeof addCharacterToCastBody> & {
	conversationId: number;
};

export function addCharacterToCast(
	database: Database,
	input: AddCharacterToCastInput,
): ConversationSnapshot {
	const add = database.transaction(() => {
		const fork = forkCharacter(
			database,
			input.characterId,
			input.expectedCharacterRevision,
		);

		// ==[HUMAN APPROVED]== The deep Conversation command validates the destination revision
		// and existence inside the same transaction; appending a fork copies
		// the authoritative server-side Definition just read from the Library
		// and records immutable provenance.
		return createConversationModule(database).execute({
			conversationId: input.conversationId,
			expectedRevision: input.expectedConversationRevision,
			action: {
				type: "add-participant",
				definition: fork.definition,
				sourceCharacterId: fork.sourceCharacterId,
			},
		});
	});

	return add.immediate();
}