import { and, eq, isNull } from "drizzle-orm";
import type { BoxId } from "../../../shared/contract/box";
import type { BoxDataWrite } from "../../../shared/contract/box-actions";
import { characterTable } from "../../database/schema";
import { putCharacterValue, putLibraryValue, putParticipantValue } from "../../box/stored-value";
import { InvalidConversationCommandError } from "../errors";
import { requireBoxInstance, requireParticipant, type ConversationDatabase } from "../internal";

const guardShared = (expected: number) => (current: { readonly revision: number }) => {
	if (current.revision !== expected) throw new InvalidConversationCommandError("Another Chat changed this value since it was read. Review it and try again.");
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
	const write = { key: input.key, value: input.value };
	switch (input.owner.type) {
		case "library":
			putLibraryValue(db, input.box, write, guardShared(input.owner.revision));
			return;
		case "character": {
			const { characterId } = input.owner;
			const character = db.select({ id: characterTable.id }).from(characterTable).where(and(eq(characterTable.id, characterId), isNull(characterTable.deleted_at))).get();
			if (character === undefined) throw new InvalidConversationCommandError(`Character ${characterId} is not available.`);
			putCharacterValue(db, input.box, characterId, write, guardShared(input.owner.revision));
			return;
		}
		case "participant":
			requireParticipant(db, input.conversationId, input.owner.participantId);
			putParticipantValue(db, input.box, input.owner.participantId, write);
	}
}
