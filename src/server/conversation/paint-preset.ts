import type { Database } from "bun:sqlite";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { conversationPromptPresetTable, promptPresetBlockTable, promptPresetTable } from "../database/schema";
import { ConversationNotFoundError } from "./errors";
import type { PaintPresetSettings } from "../../shared/contract/painting";

export const readPaintPresetSettings = (database: Database, conversationId: number): PaintPresetSettings => {
	const db = drizzle(database);
	const selection = readPaintPresetSelection(database, conversationId);
	const presets = db.select({ id: promptPresetTable.id, name: promptPresetTable.name }).from(promptPresetTable)
		.innerJoin(promptPresetBlockTable, eq(promptPresetBlockTable.preset_id, promptPresetTable.id))
		.where(and(eq(promptPresetBlockTable.reference, "brief-instruction"), eq(promptPresetBlockTable.enabled, true))).orderBy(asc(promptPresetTable.id)).all();
	return { paintPresetId: selection.paintPresetId, briefMessageCount: selection.briefMessageCount, paintPresets: presets };
};

export const readPaintPresetSelection = (database: Database, conversationId: number): Pick<PaintPresetSettings, "paintPresetId" | "briefMessageCount"> => {
	const selection = drizzle(database).select({ paintPresetId: conversationPromptPresetTable.paint_preset_id, briefMessageCount: conversationPromptPresetTable.brief_message_count })
		.from(conversationPromptPresetTable).where(eq(conversationPromptPresetTable.conversation_id, conversationId)).get();
	if (!selection) throw new ConversationNotFoundError(conversationId);
	return selection;
};
