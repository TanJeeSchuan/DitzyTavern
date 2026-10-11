import { and, eq, isNull, sql } from "drizzle-orm";
import { boxReference } from "../../../shared/contract/box";
import type { ConversationAction } from "../../../shared/contract/conversation-schema";
import {
	characterDataTable,
	characterTable,
	libraryDataTable,
	participantDataTable,
} from "../../database/schema";
import { InvalidConversationCommandError } from "../errors";
import { isBoxEnabled } from "../../box/setup";
import { requireParticipant, type ConversationDatabase } from "../internal";

export type PutBoxDataInput = { conversationId: number } & Extract<
	ConversationAction,
	{ type: "put-box-data" }
>;

// @approved
//  The host command behind every Box window's own data scope. The Box id is
//  the namespace, and only an enabled Box has a window, so a write for any
//  other Box is rejected. The owner must be a live Character, a Participant
//  of this Conversation, or the Library; a missing owner is a typed invalid
//  command, never a silent orphan row.
export function putBoxData(db: ConversationDatabase, input: PutBoxDataInput) {
	if (!isBoxEnabled(db, input.conversationId, input.box)) throw new InvalidConversationCommandError(`The ${input.box} Box is not enabled in this Chat, so it takes no data.`);
	const namespace = boxReference(input.box);
	switch (input.owner.type) {
		case "library":
			db.insert(libraryDataTable)
				.values({ namespace, key: input.key, value: input.value })
				.onConflictDoUpdate({
					target: [libraryDataTable.namespace, libraryDataTable.key],
					set: { value: input.value, revision: sql`${libraryDataTable.revision} + 1` },
				})
				.run();
			return;
		case "character": {
			const character = db
				.select({ id: characterTable.id })
				.from(characterTable)
				.where(
					and(
						eq(characterTable.id, input.owner.characterId),
						isNull(characterTable.deleted_at),
					),
				)
				.get();
			if (character === undefined) {
				throw new InvalidConversationCommandError(
					`Character ${input.owner.characterId} is not available.`,
				);
			}
			db.insert(characterDataTable)
				.values({
					character_id: input.owner.characterId,
					namespace,
					key: input.key,
					value: input.value,
				})
				.onConflictDoUpdate({
					target: [
						characterDataTable.character_id,
						characterDataTable.namespace,
						characterDataTable.key,
					],
					set: { value: input.value },
				})
				.run();
			return;
		}
		case "participant":
			requireParticipant(db, input.conversationId, input.owner.participantId);
			db.insert(participantDataTable)
				.values({
					participant_id: input.owner.participantId,
					namespace,
					key: input.key,
					value: input.value,
				})
				.onConflictDoUpdate({
					target: [
						participantDataTable.participant_id,
						participantDataTable.namespace,
						participantDataTable.key,
					],
					set: { value: input.value },
				})
				.run();
	}
}
