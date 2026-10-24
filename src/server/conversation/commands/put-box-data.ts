import { and, eq, isNull } from "drizzle-orm";
import { boxReference, type BoxId } from "../../../shared/contract/box";
import type { BoxDataWrite } from "../../../shared/contract/box-actions";
import {
	characterDataTable,
	characterTable,
	participantDataTable,
} from "../../database/schema";
import { putLibraryValue } from "../../box/stored-value";
import { InvalidConversationCommandError } from "../errors";
import { requireBoxInstance, requireParticipant, type ConversationDatabase } from "../internal";

const guardShared = (row: { revision: number } | undefined, expected: number) => {
	if ((row?.revision ?? 0) !== expected) throw new InvalidConversationCommandError("Another Chat changed this value since it was read. Review it and try again.");
};

// @approved
//  The host command behind every Box window's own data scope. The Box id is
//  the namespace, and only a Box present in the Chat, enabled or disabled,
//  has a window, so a write for an absent Box is rejected, as its setup is.
//  The owner must be a live Character, a Participant of this Conversation,
//  or the Library; a missing owner is a typed invalid command, never a
//  silent orphan row. A setup save runs the same handler for each write it
//  carries.
export function putBoxData(db: ConversationDatabase, input: { conversationId: number; box: BoxId } & BoxDataWrite) {
	requireBoxInstance(db, input.conversationId, input.box);
	const namespace = boxReference(input.box);
	switch (input.owner.type) {
		case "library": {
			const expected = input.owner.revision;
			putLibraryValue(db, { namespace, key: input.key, value: input.value }, (current) => guardShared(current, expected));
			return;
		}
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
			guardShared(db.select({ revision: characterDataTable.revision }).from(characterDataTable).where(and(
				eq(characterDataTable.character_id, input.owner.characterId),
				eq(characterDataTable.namespace, namespace),
				eq(characterDataTable.key, input.key),
			)).get(), input.owner.revision);
			const revision = input.owner.revision + 1;
			db.insert(characterDataTable)
				.values({
					character_id: input.owner.characterId,
					namespace,
					key: input.key,
					value: input.value,
					revision,
				})
				.onConflictDoUpdate({
					target: [
						characterDataTable.character_id,
						characterDataTable.namespace,
						characterDataTable.key,
					],
					set: { value: input.value, revision },
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
