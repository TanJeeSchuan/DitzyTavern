// ==[HUMAN APPROVED]== Save Participant as Character workflow.
//
// Composes the Conversation and Character Library seams in one transaction:
// the destination Conversation must match its expected revision, and the
// authoritative Participant Definition is read server-side from the current
// snapshot — a stale client-submitted Definition can never become the new
// Character's source. The Participant itself is untouched: it keeps its own
// local Definition and immutable provenance (including none when it was ad
// hoc), and the new Character carries no reference back to the Participant.
// The two records therefore have no live link, synchronization, relinking,
// reset, merge, or rebase behavior.

import type { Database } from "bun:sqlite";
import type { CharacterSnapshot } from "../character-library";
import { withCharacterLibrary } from "../character-library";
import {
	ConversationNotFoundError,
	ParticipantNotFoundError,
	StaleConversationRevisionError,
	createConversationModule,
} from "../conversation";

export interface SaveParticipantAsCharacterInput {
	conversationId: number;
	expectedConversationRevision: number;
	participantId: number;
}

export interface SaveParticipantAsCharacterResult {
	character: CharacterSnapshot;
}

// ==[HUMAN APPROVED]== Creates one new reusable Character whose Definition is an exact copy of
// the Participant's current authoritative Definition. Duplicate Character
// names are allowed, so this succeeds even when the Library already holds a
// Character with the same name. The Conversation revision is checked but
// never advanced: saving does not mutate the Conversation in any way.
export function saveParticipantAsCharacter(
	database: Database,
	input: SaveParticipantAsCharacterInput,
): SaveParticipantAsCharacterResult {
	const save = database.transaction(() => {
		const conversation =
			createConversationModule(database).getSnapshot(input.conversationId);
		if (conversation === undefined) {
			throw new ConversationNotFoundError(input.conversationId);
		}
		if (conversation.revision !== input.expectedConversationRevision) {
			throw new StaleConversationRevisionError(
				input.expectedConversationRevision,
				conversation.revision,
			);
		}

		const participant = conversation.cast.find(
			(candidate) => candidate.id === input.participantId,
		);
		if (participant === undefined) {
			throw new ParticipantNotFoundError(
				input.conversationId,
				input.participantId,
			);
		}

		// ==[HUMAN APPROVED]== Copy the authoritative server-side Definition into a new library
		// Character. Creation is atomic: the lifecycle row, Prompt row, and
		// all Opening rows commit together or not at all.
		return withCharacterLibrary(database, (library) => ({
			character: library.execute({
				type: "create",
				definition: {
					name: participant.name,
					prompt: participant.prompt,
					openings: participant.openings,
				},
			}),
		}));
	});

	return save.immediate();
}