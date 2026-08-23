import { and, eq, isNotNull } from "drizzle-orm";
import { messageTable, participantTable } from "../../database/schema";
import type { ConversationDatabase } from "../internal";
import { hasRetainedParticipantReference } from "../internal";
import { requireMessage } from "../internal";

export interface DeleteMessageInput {
	conversationId: number;
	messageId: number;
}

// Tombstones are garbage-collected in the same domain transaction (the
// command transaction wrapping this call) once their final retained
// reference disappears. Messages are the only rows that refer to a
// Participant — Author Stamp or historical Control pair — so deleting the
// last referencing Message releases its tombstone. A narrow cleanup like
// this stays inside the Conversation domain; no general business-rule
// triggers are involved.
const collectReleasedTombstones = (
	db: ConversationDatabase,
	conversationId: number,
) => {
	const tombstones = db
		.select({ id: participantTable.id })
		.from(participantTable)
		.where(
			and(
				eq(participantTable.chat_id, conversationId),
				isNotNull(participantTable.deleted_at),
			),
		)
		.all();

	for (const tombstone of tombstones) {
		if (
			!hasRetainedParticipantReference(
				db,
				conversationId,
				tombstone.id,
			)
		) {
			db.delete(participantTable)
				.where(eq(participantTable.id, tombstone.id))
				.run();
		}
	}
};

export function deleteMessage(db: ConversationDatabase, input: DeleteMessageInput) {
	requireMessage(db, input.conversationId, input.messageId);
	db.delete(messageTable).where(eq(messageTable.id, input.messageId)).run();
	collectReleasedTombstones(db, input.conversationId);
}