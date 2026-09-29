import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { conversationTable } from "../database/schema";
import { abortMemoryWork } from "../memory/work";
import { ConversationNotFoundError, InvalidConversationCommandError } from "./errors";
import { connectConversationDatabase, hasActiveGeneration } from "./internal";

// ==[HUMAN APPROVED]== Deletes a Chat and, through foreign-key cascades, everything it owns. A
// running Generation must be stopped first so no attempt writes into a
// Conversation that no longer exists.
export function deleteConversation(database: Database, conversationId: number) {
	if (hasActiveGeneration(database, conversationId)) {
		throw new InvalidConversationCommandError("Stop the running Generation before deleting this Chat.");
	}
	abortMemoryWork(database, database.query<{ id: number }, [number]>("SELECT variant_id AS id FROM memory_collection WHERE conversation_id = ?").all(conversationId).map(({ id }) => id));
	const deleted = connectConversationDatabase(database)
		.delete(conversationTable)
		.where(eq(conversationTable.id, conversationId))
		.returning({ id: conversationTable.id })
		.all();
	if (deleted.length === 0) throw new ConversationNotFoundError(conversationId);
}
