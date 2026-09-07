import type { Database } from "bun:sqlite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	conversationPromptPresetTable,
	promptPresetBlockTable,
	promptPresetTable,
} from "../database/schema";
import {
	promptBlockReference,
	type PromptBlockReference,
	type PromptPresetRecipe,
} from "../../shared/contract/prompt-preset";
import { Value } from "@sinclair/typebox/value";

const connect = (database: Database) => drizzle(database);
type PromptPresetDatabase = ReturnType<typeof connect>;

export class PromptPresetNotInitializedError extends Error {
	constructor() {
		super("The Default Prompt Preset is missing from the preset library.");
		this.name = "PromptPresetNotInitializedError";
	}
}

// ==[HUMAN APPROVED]== A stored slot whose reference is outside the supported vocabulary cannot
// be assembled and cannot be shown; failing here names the offending row
// instead of silently dropping content from every later Generation.
const requireReference = (value: string, presetId: number): PromptBlockReference => {
	if (!Value.Check(promptBlockReference, value)) {
		throw new Error(
			`Prompt Preset ${presetId} references the unsupported block "${value}".`,
		);
	}
	return value;
};

/** ==[HUMAN APPROVED]== The identifier of the one Default preset every Conversation starts on. */
export const readDefaultPromptPresetId = (db: PromptPresetDatabase): number => {
	const row = db
		.select({ id: promptPresetTable.id })
		.from(promptPresetTable)
		.where(eq(promptPresetTable.is_default, true))
		.get();
	if (row === undefined) throw new PromptPresetNotInitializedError();
	return row.id;
};

/** ==[HUMAN APPROVED]== Records a new Conversation's initial selection of the Default preset. */
export const selectDefaultPromptPreset = (
	db: PromptPresetDatabase,
	conversationId: number,
): void => {
	db.insert(conversationPromptPresetTable)
		.values({
			conversation_id: conversationId,
			prompt_preset_id: readDefaultPromptPresetId(db),
		})
		.run();
};

/**
 * ==[HUMAN APPROVED]== The recipe a Conversation assembles through. Undefined only when the
 * Conversation itself does not exist; a Conversation always has a selection.
 */
export const readConversationPromptPresetRecipe = (
	database: Database,
	conversationId: number,
): PromptPresetRecipe | undefined => {
	const db = connect(database);
	const preset = db
		.select({ id: promptPresetTable.id, name: promptPresetTable.name })
		.from(conversationPromptPresetTable)
		.innerJoin(
			promptPresetTable,
			eq(promptPresetTable.id, conversationPromptPresetTable.prompt_preset_id),
		)
		.where(eq(conversationPromptPresetTable.conversation_id, conversationId))
		.get();
	if (preset === undefined) return undefined;
	const slots = db
		.select({
			reference: promptPresetBlockTable.reference,
			enabled: promptPresetBlockTable.enabled,
		})
		.from(promptPresetBlockTable)
		.where(eq(promptPresetBlockTable.preset_id, preset.id))
		.orderBy(asc(promptPresetBlockTable.position))
		.all();
	return {
		id: preset.id,
		name: preset.name,
		slots: slots.map((slot) => ({
			reference: requireReference(slot.reference, preset.id),
			enabled: slot.enabled,
		})),
	};
};
