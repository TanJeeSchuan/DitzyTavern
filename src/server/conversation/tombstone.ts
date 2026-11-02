import { eq } from "drizzle-orm";
import { collectReleasedCharacterTombstones } from "../character-library";
import {
	participantTable, participantPromptTable, participantOpeningTable,
	participantDataTable, participantLorebookAttachmentTable,
} from "../database/schema";
import { hasRetainedParticipantReference, type ConversationDatabase, type ParticipantRow } from "./internal";

export function tombstone(db: ConversationDatabase, participant: ParticipantRow): void {
	if (!hasRetainedParticipantReference(db, participant.conversation_id, participant.id)) {
		db.delete(participantTable).where(eq(participantTable.id, participant.id)).run();
		if (participant.source_character_id !== null) collectReleasedCharacterTombstones(db, [participant.source_character_id]);
		return;
	}
	db.update(participantTable).set({ deleted_at: new Date().toISOString(), position: 0 }).where(eq(participantTable.id, participant.id)).run();
	db.delete(participantPromptTable).where(eq(participantPromptTable.participant_id, participant.id)).run();
	db.delete(participantOpeningTable).where(eq(participantOpeningTable.participant_id, participant.id)).run();
	db.delete(participantDataTable).where(eq(participantDataTable.participant_id, participant.id)).run();
	db.delete(participantLorebookAttachmentTable).where(eq(participantLorebookAttachmentTable.participant_id, participant.id)).run();
}
