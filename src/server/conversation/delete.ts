import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { conversationTable, messageTable, messageVariantTable } from "../database/schema";
import { ConversationNotFoundError, InvalidConversationCommandError } from "./errors";
import { hasActiveGenerationFromConnection } from "./internal";
import { runConversationTransaction } from "./commands/transaction";

// @approved
//  Deletes a Chat and, through foreign-key cascades, everything it owns. A
// running Generation must be stopped first so no attempt writes into a
// Conversation that no longer exists. The guard reads the shared Active
// Generation existence probe inside the write transaction so a Generation
// starting between the probe and the delete cannot commit into a vanished Chat.
export function deleteConversation(database: Database, conversationId: number) {
	return runConversationTransaction(database, (db, reportChange) => {
		if (hasActiveGenerationFromConnection(db, conversationId)) {
			throw new InvalidConversationCommandError("Stop the running Generation before deleting this Chat.");
		}
		// @approved
		//  The Variant ids are enumerated before the cascading delete so
		// Memory can abandon their in-flight work when the write commits.
		const removedVariantIds = db
			.select({ id: messageVariantTable.id })
			.from(messageVariantTable)
			.innerJoin(messageTable, eq(messageTable.id, messageVariantTable.message_id))
			.where(eq(messageTable.conversation_id, conversationId))
			.all()
			.map(({ id }) => id);
		const deleted = db
			.delete(conversationTable)
			.where(eq(conversationTable.id, conversationId))
			.returning({ id: conversationTable.id })
			.all();
		if (deleted.length === 0) throw new ConversationNotFoundError(conversationId);
		reportChange({
			conversationId,
			touchedVariantIds: [],
			removedVariantIds,
			promptPresetChanged: false,
		});
	});
}
