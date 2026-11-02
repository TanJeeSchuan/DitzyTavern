import { eq } from "drizzle-orm";
import { collectReleasedTombstones } from "../cleanup";
import { messageTable, messageVariantTable } from "../../database/schema";
import type { ConversationWriteChange } from "../../../shared/contract/conversation-write-change";
import type { ConversationDatabase } from "../internal";
import { requireMessage } from "../internal";

export interface DeleteMessageInput {
	conversationId: number;
	messageId: number;
}

export function deleteMessage(
	db: ConversationDatabase,
	input: DeleteMessageInput,
): ConversationWriteChange {
	requireMessage(db, input.conversationId, input.messageId);
	// @approved
	//  The Message deletion cascades to its Variants; the ids are
	// enumerated before the delete so Memory can abandon their in-flight work.
	const removedVariantIds = db
		.select({ id: messageVariantTable.id })
		.from(messageVariantTable)
		.where(eq(messageVariantTable.message_id, input.messageId))
		.all()
		.map(({ id }) => id);
	db.delete(messageTable).where(eq(messageTable.id, input.messageId)).run();
	collectReleasedTombstones(db, input.conversationId);
	return {
		conversationId: input.conversationId,
		touchedVariantIds: [],
		removedVariantIds,
	};
}
