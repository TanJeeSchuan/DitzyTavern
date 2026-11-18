import { eq } from "drizzle-orm";
import { collectReleasedTombstones } from "./cleanup";
import {
	participantTable, participantPromptTable, participantOpeningTable,
	participantDataTable, participantLorebookAttachmentTable,
} from "../database/schema";
import type { ConversationDatabase, ParticipantRow } from "./internal";

export function tombstone(db: ConversationDatabase, participant: ParticipantRow): void {
	db.update(participantTable).set({ deleted_at: new Date().toISOString(), position: 0 }).where(eq(participantTable.id, participant.id)).run();
	db.delete(participantPromptTable).where(eq(participantPromptTable.participant_id, participant.id)).run();
	db.delete(participantOpeningTable).where(eq(participantOpeningTable.participant_id, participant.id)).run();
	db.delete(participantDataTable).where(eq(participantDataTable.participant_id, participant.id)).run();
	db.delete(participantLorebookAttachmentTable).where(eq(participantLorebookAttachmentTable.participant_id, participant.id)).run();
	collectReleasedTombstones(db, participant.conversation_id);
}
