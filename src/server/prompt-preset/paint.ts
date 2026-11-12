import type { Database } from "bun:sqlite";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { conversationPromptPresetTable, promptPresetBlockTable, promptPresetTable } from "../database/schema";
import { ConversationNotFoundError, InvalidConversationCommandError } from "../conversation";
import { hasEnabledBriefInstruction } from "../../shared/contract/prompt-preset";
import { readPromptPresetRecipe } from "./recipe";
import type { PaintPresetSettings, PaintPresetCommand } from "../../shared/contract/painting";

export const readPaintPresetSettings = (database: Database, conversationId: number): PaintPresetSettings => {
	const db = drizzle(database);
	const selection = db.select().from(conversationPromptPresetTable).where(eq(conversationPromptPresetTable.conversation_id, conversationId)).get();
	if (!selection) throw new ConversationNotFoundError(conversationId);
	const presets = db.select({ id: promptPresetTable.id, name: promptPresetTable.name }).from(promptPresetTable)
		.innerJoin(promptPresetBlockTable, eq(promptPresetBlockTable.preset_id, promptPresetTable.id))
		.where(and(eq(promptPresetBlockTable.reference, "brief-instruction"), eq(promptPresetBlockTable.enabled, true))).orderBy(asc(promptPresetTable.id)).all();
	return { paintPresetId: selection.paint_preset_id, briefMessageCount: selection.brief_message_count, paintPresets: presets };
};

export const commandPaintPreset = (database: Database, conversationId: number, command: PaintPresetCommand): void => {
	const db = drizzle(database);
	database.transaction(() => {
		if (command.type === "select-paint-preset") {
			const recipe = readPromptPresetRecipe(database, command.paintPresetId);
			if (!recipe || !hasEnabledBriefInstruction(recipe.slots)) throw new InvalidConversationCommandError("Choose a Paint Preset with an enabled Brief instruction.");
		}
		db.update(conversationPromptPresetTable)
			.set(command.type === "select-paint-preset" ? { paint_preset_id: command.paintPresetId } : { brief_message_count: command.briefMessageCount })
			.where(eq(conversationPromptPresetTable.conversation_id, conversationId)).run();
	}).immediate();
};
