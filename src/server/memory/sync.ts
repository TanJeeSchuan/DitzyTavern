import type { Database } from "bun:sqlite";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { memoryCollectionTable, messageVariantTable } from "../database/schema";
import type { ConversationMemoryChange } from "../../shared/contract/conversation-memory-change";
import { invalidateMemoryWorkForConversation } from "./cancellation";
import { invalidateMemoryWorkForVariant, queueMemorySource, queueMemoryTail } from "./collections";
import { sha256 } from "./hash";
import { abortMemoryWork, registeredMemoryVariants } from "./work";

export function refreshMemoryForConversation(database: Database, conversationId: number, reason?: string): void {
	invalidateMemoryWorkForConversation(database, conversationId, reason);
	queueMemoryTail(database, conversationId);
}

// ==[HUMAN APPROVED]== Apply one Conversation-reported change to Memory's own tables. The
// deep Conversation module reports what it changed instead of calling
// Memory from inside its write transactions; the application layer delivers
// the record here inside the same transaction wrapper, so Memory reads
// exactly the state the write commits. Memory touches no Conversation
// tables: abandoned Variants are named in the report, and touched Variants
// join Memory's collection table for the staleness check.
export function syncMemorySources(database: Database, change: ConversationMemoryChange): void {
	if (change.removedVariantIds.length > 0) {
		const removed = new Set(change.removedVariantIds);
		abortMemoryWork(database, registeredMemoryVariants(database).filter((id) => removed.has(id)));
	}
	if (change.touchedVariantIds.length > 0) {
		const rows = new Map(drizzle(database)
			.select({ id: messageVariantTable.id, messageId: messageVariantTable.message_id, selected: messageVariantTable.selected, content: messageVariantTable.content, sourceHash: memoryCollectionTable.source_hash })
			.from(messageVariantTable)
			.leftJoin(memoryCollectionTable, eq(memoryCollectionTable.variant_id, messageVariantTable.id))
			.where(inArray(messageVariantTable.id, [...change.touchedVariantIds]))
			.all()
			.map((row) => [row.id, row] as const));
		for (const id of change.touchedVariantIds) {
			const row = rows.get(id);
			if (!row) continue;
			if (row.sourceHash !== null && row.sourceHash !== sha256(row.content)) invalidateMemoryWorkForVariant(database, id);
			if (row.selected) queueMemorySource(database, change.conversationId, row.messageId);
		}
	}
	if (change.promptPresetChanged) refreshMemoryForConversation(database, change.conversationId);
}
