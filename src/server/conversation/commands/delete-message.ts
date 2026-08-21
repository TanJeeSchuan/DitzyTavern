import { eq } from "drizzle-orm";
import { messageTable } from "../../database/schema";
import type { ConversationDatabase } from "../internal";
import { requireMessage } from "../internal";

export interface DeleteMessageInput {
	conversationId: number;
	messageId: number;
}

export function deleteMessage(db: ConversationDatabase, input: DeleteMessageInput) {
	requireMessage(db, input.conversationId, input.messageId);
	db.delete(messageTable).where(eq(messageTable.id, input.messageId)).run();
}
