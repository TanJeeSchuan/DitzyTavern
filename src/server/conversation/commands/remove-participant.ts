import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { collectReleasedCharacterTombstones } from "../../character-library";
import {
	participantOpeningTable,
	participantPromptTable,
	participantTable,
} from "../../database/schema";
import { ParticipantNotRemovableError } from "../errors";
import {
	type ConversationDatabase,
	hasRetainedParticipantReference,
	readControlAssignment,
	requireParticipant,
} from "../internal";

export interface RemoveParticipantInput {
	conversationId: number;
	participantId: number;
}

// ==[HUMAN APPROVED]== Removes an unseated Participant after confirmation.
//
// Seated Participants are protected: the derived snapshot eligibility
// explains that a Control seat must be reassigned first, and this command
// enforces the same rule with the typed not-removable outcome.
//
// An unseated Participant with no retained reference is hard-deleted (the
// Prompt and Opening children cascade away). A Participant still referred to
// by Messages — Author Stamp or historical Control pair — is reduced to a
// nonrestorable tombstone keeping only stable identity, final name,
// Conversation identity, and Character provenance: its Definition children
// are stripped and it leaves the Cast. Either way, later active Cast
// positions are compacted transactionally so the remaining roster stays
// contiguous.
export function removeParticipant(
	db: ConversationDatabase,
	input: RemoveParticipantInput,
) {
	const participant = requireParticipant(
		db,
		input.conversationId,
		input.participantId,
	);

	const control = readControlAssignment(db, input.conversationId);
	if (
		participant.id === control.humanParticipantId ||
		participant.id === control.modelParticipantId
	) {
		throw new ParticipantNotRemovableError(
			input.conversationId,
			participant.id,
		);
	}

	const referenced = hasRetainedParticipantReference(
		db,
		input.conversationId,
		participant.id,
	);

	if (!referenced) {
		// ==[HUMAN APPROVED]== Hard deletion: no Message refers to this Participant, so removing
		// the base row is safe and cascades the Definition children. When the
		// Participant was forked from a Character, this removal may release
		// the final provenance reference of an already-tombstoned source
		// Character, which the narrow cleanup mechanism then garbage-collects
		// in the same transaction.
		db.delete(participantTable)
			.where(eq(participantTable.id, participant.id))
			.run();
		if (participant.source_character_id !== null) {
			collectReleasedCharacterTombstones(db, [
				participant.source_character_id,
			]);
		}
	} else {
		// ==[HUMAN APPROVED]== Tombstone: keep the minimal base row for structural references;
		// strip the Definition children and leave the Cast. The tombstone
		// carries the position sentinel 0 (it is not a Cast member, and the
		// partial unique index covers only active rows), and only stable
		// identity, final name, Conversation identity, and Character
		// provenance are retained.
		db.update(participantTable)
			.set({ deleted_at: new Date().toISOString(), position: 0 })
			.where(eq(participantTable.id, participant.id))
			.run();
		db.delete(participantPromptTable)
			.where(eq(participantPromptTable.participant_id, participant.id))
			.run();
		db.delete(participantOpeningTable)
			.where(eq(participantOpeningTable.participant_id, participant.id))
			.run();
	}

	// ==[HUMAN APPROVED]== Compacting later active Cast positions transactionally keeps the active
	// roster contiguous after either removal path.
	db.update(participantTable)
		.set({ position: sql`${participantTable.position} - 1` })
		.where(
			and(
				eq(participantTable.chat_id, input.conversationId),
				gt(participantTable.position, participant.position),
				isNull(participantTable.deleted_at),
			),
		)
		.run();
}
