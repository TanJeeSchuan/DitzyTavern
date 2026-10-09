import { readVariantsForMemory } from "../conversation";
import type { Database } from "bun:sqlite";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { memoryCollectionTable } from "../database/schema";
import type { ConversationMemoryChange } from "../../shared/contract/conversation-memory-change";
import { invalidateMemoryWorkForConversation } from "./cancellation";
import { invalidateMemoryWorkForVariant, queueMemorySource, queueMemoryTail } from "./collections";
import { sha256 } from "./hash";
import { abortMemoryWork } from "./work";

export function refreshMemoryForConversation(database: Database, conversationId: number, reason?: string): void {
	invalidateMemoryWorkForConversation(database, conversationId, reason);
	queueMemoryTail(database, conversationId);
}

// @approved
//  Apply one Conversation-reported change to Memory's own tables. The
// deep Conversation module reports what it changed instead of calling
// Memory from inside its write transactions; the application layer delivers
// the record here inside the same transaction wrapper, so Memory reads
// exactly the state the write commits. Memory touches no Conversation
// tables: abandoned Variants are named in the report, and touched Variants
// join Memory's collection table for the staleness check.
export function syncMemorySources(database: Database, change: ConversationMemoryChange): void {
	if (change.removedVariantIds.length > 0) {
		// @approved
		//  Exactly the reported removals are abandoned: the report names
		// the Variant rows this write deleted, so no registered-variant scan is
		// needed to rediscover them.
		abortMemoryWork(database, change.removedVariantIds);
	}
	if (change.touchedVariantIds.length > 0) {
		const collections = new Map(drizzle(database).select().from(memoryCollectionTable).where(inArray(memoryCollectionTable.variant_id,
			[...change.touchedVariantIds])).all().map((row) => [row.variant_id, row]));
		const rows = new Map(readVariantsForMemory(database, change.conversationId, { variantIds: change.touchedVariantIds,
			includeActive: true }).map((variant) => [variant.variantId, { ...variant, sourceHash: collections.get(variant.variantId)?.source_hash ?? null }]));
		for (const id of change.touchedVariantIds) {
			const row = rows.get(id);
			if (!row) continue;
			if (row.sourceHash !== null && row.sourceHash !== sha256(row.content)) invalidateMemoryWorkForVariant(database, id);
			if (row.selected) queueMemorySource(database, change.conversationId, row.messageId);
		}
	}
	if (change.promptPresetChanged) refreshMemoryForConversation(database, change.conversationId);
}
