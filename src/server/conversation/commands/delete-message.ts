import { and, eq, isNotNull } from "drizzle-orm";
import { messageTable, participantTable } from "../../database/schema";
import type { ConversationDatabase } from "../internal";
import { messageReferencesParticipant } from "../internal";
import { requireMessage } from "../internal";

export interface DeleteMessageInput {
	conversationId: number;
	messageId: number;
}

// Tombstones are garbage-collected in the same domain transaction (the
// command transaction wrapping this call) once their final retained
// reference disappears. Messages are the only rows that refer to a
// Participant — Author Stamp or historical Control pair — so deleting the
// last referencing Message releases its tombstone. This narrow cleanup is
// intentionally scoped to the Conversation domain: no general business-rule
// triggers exist, and no other command removes a retained reference.
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
	if (tombstones.length === 0) return;

	// One projection of the surviving Messages drives every tombstone check
	// through the shared reference predicate, so collection can never drift
	// from the removal rule.
	const messages = db
		.select({
			authorParticipantId: messageTable.author_participant_id,
			contextHumanParticipantId: messageTable.context_human_participant_id,
			contextModelParticipantId: messageTable.context_model_participant_id,
		})
		.from(messageTable)
		.where(eq(messageTable.chat_id, conversationId))
		.all();

	for (const tombstone of tombstones) {
		if (
			!messages.some((message) =>
				messageReferencesParticipant(message, tombstone.id),
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
