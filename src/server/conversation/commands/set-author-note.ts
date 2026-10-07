import { eq } from "drizzle-orm";
import { conversationTable } from "../../database/schema";
import type { ConversationDatabase } from "../internal";

export function setAuthorNote(db: ConversationDatabase, input: { conversationId: number; content: string }) {
	db.update(conversationTable).set({ author_note: input.content }).where(eq(conversationTable.id, input.conversationId)).run();
}
