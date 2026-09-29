import type { Database } from "bun:sqlite";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { conversationPromptPresetTable, memoryCollectionTable } from "../database/schema";
import { isMemoryEnabledForConversation } from "./settings";
import { abortMemoryWork } from "./work";

const presetChanged = "The selected Prompt Preset changed. Reset and re-extract this source to try again.";

// ==[HUMAN APPROVED]== Invalidate in-flight work when one of its shared recipe inputs changes.
export function invalidateMemoryWorkForPreset(database: Database, presetId: number, reason = presetChanged) {
	const conversations = drizzle(database).select({ id: conversationPromptPresetTable.conversation_id }).from(conversationPromptPresetTable).where(eq(conversationPromptPresetTable.prompt_preset_id, presetId)).all();
	for (const { id } of conversations) invalidateMemoryWorkForConversation(database, id, reason);
}

export function invalidateMemoryWorkForConversation(database: Database, conversationId: number, reason = presetChanged) {
	const db = drizzle(database);
	const superseded = db.update(memoryCollectionTable).set({ work_epoch: sql`${memoryCollectionTable.work_epoch} + 1`, status: "failed", error: reason, updated_at: new Date().toISOString() })
		.where(and(eq(memoryCollectionTable.conversation_id, conversationId), eq(memoryCollectionTable.ownership, "automatic"), inArray(memoryCollectionTable.status, ["pending", "running"])))
		.returning({ id: memoryCollectionTable.variant_id }).all();
	abortMemoryWork(database, superseded.map(({ id }) => id));
	if (!isMemoryEnabledForConversation(database, conversationId)) abortMemoryWork(database, db.select({ id: memoryCollectionTable.variant_id }).from(memoryCollectionTable).where(eq(memoryCollectionTable.conversation_id, conversationId)).all().map(({ id }) => id));
}
