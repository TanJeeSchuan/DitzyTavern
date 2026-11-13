import type { Database } from "bun:sqlite";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { conversationPromptPresetTable, promptPresetBlockTable, promptPresetTable } from "../database/schema";
import { runConversationTransaction } from "./commands/transaction";
import { ConversationNotFoundError } from "./errors";
import { requirePaintPresetRecipe } from "../prompt-preset";
import type { PaintPresetSettings, PaintPresetCommand } from "../../shared/contract/painting";

export const readPaintPresetSettings = (database: Database, conversationId: number): PaintPresetSettings => {
	const db = drizzle(database);
	const selection = readPaintPresetSelection(database, conversationId);
	const presets = db.select({ id: promptPresetTable.id, name: promptPresetTable.name }).from(promptPresetTable)
		.innerJoin(promptPresetBlockTable, eq(promptPresetBlockTable.preset_id, promptPresetTable.id))
		.where(and(eq(promptPresetBlockTable.reference, "brief-instruction"), eq(promptPresetBlockTable.enabled, true))).orderBy(asc(promptPresetTable.id)).all();
	return { paintPresetId: selection.paintPresetId, briefMessageCount: selection.briefMessageCount, paintPresets: presets };
};

export const commandPaintPreset = (database: Database, conversationId: number, command: PaintPresetCommand): void => {
	runConversationTransaction(database, (db) => {
		if (command.type === "select-paint-preset") requirePaintPresetRecipe(database, command.paintPresetId);
		db.update(conversationPromptPresetTable)
			.set(command.type === "select-paint-preset" ? { paint_preset_id: command.paintPresetId } : { brief_message_count: command.briefMessageCount })
			.where(eq(conversationPromptPresetTable.conversation_id, conversationId)).run();
	});
};

export const readPaintPresetSelection = (database: Database, conversationId: number): Pick<PaintPresetSettings, "paintPresetId" | "briefMessageCount"> => {
	const selection = drizzle(database).select({ paintPresetId: conversationPromptPresetTable.paint_preset_id, briefMessageCount: conversationPromptPresetTable.brief_message_count })
		.from(conversationPromptPresetTable).where(eq(conversationPromptPresetTable.conversation_id, conversationId)).get();
	if (!selection) throw new ConversationNotFoundError(conversationId);
	return selection;
};
