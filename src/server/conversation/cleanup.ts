import { and, eq, isNotNull } from "drizzle-orm";
import { collectReleasedCharacterTombstones } from "../character-library";
import { messageTable, participantTable } from "../database/schema";
import { messageReferencesParticipant, type ConversationDatabase } from "./internal";

export const collectReleasedTombstones = (
	db: ConversationDatabase,
	conversationId: number,
) => {
	const tombstones = db
		.select({
			id: participantTable.id,
			sourceCharacterId: participantTable.source_character_id,
		})
		.from(participantTable)
		.where(
			and(
				eq(participantTable.conversation_id, conversationId),
				isNotNull(participantTable.deleted_at),
			),
		)
		.all();
	if (tombstones.length === 0) return;
	const releasedSourceCharacterIds: number[] = [];

	const messages = db
		.select({
			authorParticipantId: messageTable.author_participant_id,
			contextHumanParticipantId: messageTable.context_human_participant_id,
			contextModelParticipantId: messageTable.context_model_participant_id,
		})
		.from(messageTable)
		.where(eq(messageTable.conversation_id, conversationId))
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
			if (tombstone.sourceCharacterId !== null) {
				releasedSourceCharacterIds.push(tombstone.sourceCharacterId);
			}
		}
	}

	collectReleasedCharacterTombstones(db, releasedSourceCharacterIds);
};
