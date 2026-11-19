import { eq } from "drizzle-orm";
import { conversationPromptPresetTable } from "../../database/schema";
import { requirePaintPresetRecipe } from "../../prompt-preset";
import type { ConversationDatabase } from "../internal";

export const selectPaintPreset = (db: ConversationDatabase, { conversationId, paintPresetId }: { conversationId: number; paintPresetId: number }): void => {
	requirePaintPresetRecipe(db, paintPresetId);
	db.update(conversationPromptPresetTable).set({ paint_preset_id: paintPresetId }).where(eq(conversationPromptPresetTable.conversation_id, conversationId)).run();
};

export const setBriefMessageCount = (db: ConversationDatabase, { conversationId, briefMessageCount }: { conversationId: number; briefMessageCount: number | null }): void => {
	db.update(conversationPromptPresetTable).set({ brief_message_count: briefMessageCount }).where(eq(conversationPromptPresetTable.conversation_id, conversationId)).run();
};
