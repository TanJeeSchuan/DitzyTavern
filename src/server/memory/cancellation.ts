import type { Database } from "bun:sqlite";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { conversationMemorySettingsTable, conversationPromptPresetTable, memoryCollectionTable, memoryIndexWorkTable } from "../database/schema";
import { cancelMemoryIndexWork, isMemoryEnabledForConversation, queueMemoryIndexingForConversation } from "./indexing";

// ==[HUMAN APPROVED]== Invalidate in-flight work when one of its shared recipe inputs changes.
export function invalidateMemoryWorkForPreset(database: Database, presetId: number, reason = "The selected Prompt Preset changed. Reset and re-extract this source to try again.") {
	const db = drizzle(database);
	const conversations = db.select({ id: conversationPromptPresetTable.conversation_id }).from(conversationPromptPresetTable).where(eq(conversationPromptPresetTable.prompt_preset_id, presetId)).all();
	for (const { id } of conversations) invalidateMemoryWorkForConversation(database, id, reason);
}

export function invalidateMemoryWorkForConversation(database: Database, conversationId: number, reason = "The selected Prompt Preset changed. Reset and re-extract this source to try again.") {
	const db = drizzle(database);
	db.insert(conversationMemorySettingsTable).values({ conversation_id: conversationId }).onConflictDoNothing().run();
	db.update(conversationMemorySettingsTable).set({ chat_epoch: sql`${conversationMemorySettingsTable.chat_epoch} + 1` }).where(eq(conversationMemorySettingsTable.conversation_id, conversationId)).run();
	db.update(memoryCollectionTable).set({ work_epoch: sql`${memoryCollectionTable.work_epoch} + 1`, status: "failed", error: reason, updated_at: new Date().toISOString() }).where(and(eq(memoryCollectionTable.conversation_id, conversationId), inArray(memoryCollectionTable.status, ["pending", "running"]))).run();
	if (isMemoryEnabledForConversation(database, conversationId)) queueMemoryIndexingForConversation(database, conversationId);
	else {
		const variants = db.select({ id: memoryCollectionTable.variant_id }).from(memoryCollectionTable).where(eq(memoryCollectionTable.conversation_id, conversationId)).all().map(({ id }) => id);
		if (variants.length > 0) {
			for (const variantId of variants) cancelMemoryIndexWork(database, variantId);
			db.update(memoryCollectionTable).set({ index_epoch: sql`${memoryCollectionTable.index_epoch} + 1` }).where(inArray(memoryCollectionTable.variant_id, variants)).run();
			db.delete(memoryIndexWorkTable).where(inArray(memoryIndexWorkTable.variant_id, variants)).run();
		}
	}
}
