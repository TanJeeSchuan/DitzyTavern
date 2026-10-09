import type { Database } from "bun:sqlite";
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	conversationPromptPresetTable,
	promptPresetBlockTable,
	promptPresetTable,
} from "../database/schema";
import {
	type PromptOutgoingRole,
	type PromptPresetRecipe,
	type ReferencedDefinitionBlock,
	type PromptLoreReference,
} from "../../shared/contract/prompt-preset";
import { PromptPresetNotFoundError } from "./errors";

const connect = (database: Database) => drizzle(database);
export type PromptPresetDatabase = ReturnType<typeof connect>;

class PromptPresetNotInitializedError extends Error {
	constructor() {
		super("The Default Prompt Preset is missing from the preset library.");
		this.name = "PromptPresetNotInitializedError";
	}
}

type StoredPromptPresetBlock = {
	id: number;
	enabled: boolean;
} & (
	| { reference: "history"; role: null; name: null; content: null }
	| { reference: PromptLoreReference | "memory" | "author-note"; role: PromptOutgoingRole; name: null; content: null }
	| { reference: "instruction"; role: PromptOutgoingRole; name: string; content: string }
	| {
			reference: ReferencedDefinitionBlock;
			role: PromptOutgoingRole;
			name: null;
			content: null;
		}
);

/** @approved The one stored-block column selection without the occurrence id,
 * for callers that copy blocks to a fresh preset; the recipe reader's
 * selection derives from it and adds the occurrence id back. */
export const promptPresetBlockSelection = {
	position: promptPresetBlockTable.position,
	reference: promptPresetBlockTable.reference,
	enabled: promptPresetBlockTable.enabled,
	role: promptPresetBlockTable.role,
	name: promptPresetBlockTable.name,
	content: promptPresetBlockTable.content,
};

// @approved
//  The recipe reader's row shape: the shared selection plus the
// occurrence id it addresses slots by.
const storedPromptPresetBlockSelection = {
	id: promptPresetBlockTable.id,
	...promptPresetBlockSelection,
};

/** @approved The identifier of the one Default preset every Conversation starts on. */
export const readDefaultPromptPresetId = (db: PromptPresetDatabase): number => {
	const row = db
		.select({ id: promptPresetTable.id })
		.from(promptPresetTable)
		.where(eq(promptPresetTable.is_default, true))
		.get();
	if (row === undefined) throw new PromptPresetNotInitializedError();
	return row.id;
};

/** @approved Records a new Conversation's initial selection of the Default preset. */
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

// @approved
//  The Default recipe migration 0000 seeds predates the Author Note slot, and
//  no later migration may insert it: the intermediate table rebuilds still
//  reject the reference. A database the migration chain just created therefore
//  installs the slot here, directly after history, exactly as a new Default
//  recipe ships. Presets stored by an older database stay untouched; ADR-0048
//  gives them the explicit Add Author Note Block action instead.
export function installDefaultPresetAuthorNote(database: Database): void {
	database.transaction(() => {
		database.run(
			"UPDATE prompt_preset_block SET position = position + 1 WHERE preset_id = (SELECT id FROM prompt_preset WHERE is_default = 1) AND reference = 'model-post-history-instruction'",
		);
		database.run(
			"INSERT INTO prompt_preset_block (preset_id, position, reference, role) SELECT h.preset_id, h.position + 1, 'author-note', 'system' FROM prompt_preset_block h JOIN prompt_preset p ON p.id = h.preset_id WHERE p.is_default = 1 AND h.reference = 'history'",
		);
	}).immediate();
}

// @approved
//  Applies one Conversation's authoritative selection of a shared
// preset. The selection is a reference to the library entry: validation
// reads the live library row inside the caller's transaction, so a preset
// deleted concurrently can never become the stored target, and the upsert
// keeps the exactly-one-selection invariant the creation seam established.
export const selectConversationPromptPreset = (
	db: PromptPresetDatabase,
	conversationId: number,
	promptPresetId: number,
): void => {
	const preset = db
		.select({ id: promptPresetTable.id })
		.from(promptPresetTable)
		.where(eq(promptPresetTable.id, promptPresetId))
		.get();
	if (preset === undefined) throw new PromptPresetNotFoundError(promptPresetId);
	db.insert(conversationPromptPresetTable)
		.values({
			conversation_id: conversationId,
			prompt_preset_id: promptPresetId,
		})
		.onConflictDoUpdate({
			target: conversationPromptPresetTable.conversation_id,
			set: { prompt_preset_id: promptPresetId },
		})
		.run();
};

const queryBatches = <T>(values: readonly T[]): T[][] =>
	Array.from({ length: Math.ceil(values.length / 500) }, (_, index) =>
		values.slice(index * 500, (index + 1) * 500),
	);

// @approved
//  An authored instruction always stores its composed name, text,
//  and outgoing role. The stored value is never normalized or flattened,
//  including when its content is legitimately empty. The three members are
//  the stored row's own discriminant; every other projection of it (the
//  native export) derives from this one instead of restating it.
const toRecipeSlots = (
	slots: readonly StoredPromptPresetBlock[],
): PromptPresetRecipe["slots"] =>
	slots.map((slot) => {
		if (slot.reference === "history") {
			return { id: slot.id, reference: slot.reference, enabled: slot.enabled };
		}
		if (slot.reference === "instruction") {
			return {
				id: slot.id,
				reference: slot.reference,
				enabled: slot.enabled,
				role: slot.role,
				name: slot.name,
				content: slot.content,
			};
		}
		return {
			id: slot.id,
			reference: slot.reference,
			enabled: slot.enabled,
			role: slot.role,
		};
	});

const storedOccurrences = (
	db: PromptPresetDatabase,
	presetId: number,
): PromptPresetRecipe["slots"] => {
	// @approved
	//  SAFETY: prompt_preset_block_shape_check enforces this discriminated row
	// shape for every insert and update.
	const slots = db
		.select(storedPromptPresetBlockSelection)
		.from(promptPresetBlockTable)
		.where(eq(promptPresetBlockTable.preset_id, presetId))
		.orderBy(asc(promptPresetBlockTable.position))
		.all() as StoredPromptPresetBlock[];
	return toRecipeSlots(slots);
};

/** @approved
 * One preset's stored header row. Undefined when the preset does not
 * exist.
 */
const readPromptPresetHeader = (
	db: PromptPresetDatabase,
	presetId: number,
): { id: number; name: string } | undefined =>
	db
		.select({ id: promptPresetTable.id, name: promptPresetTable.name })
		.from(promptPresetTable)
		.where(eq(promptPresetTable.id, presetId))
		.get();

const presetRecipeOf = (
	preset: { id: number; name: string } | undefined,
	db: PromptPresetDatabase,
): PromptPresetRecipe | undefined =>
	preset === undefined
		? undefined
		: { id: preset.id, name: preset.name, slots: storedOccurrences(db, preset.id) };

/** @approved One stored preset's recipe by identity. Undefined when the preset does not exist. */
export const readPromptPresetRecipe = (
	database: Database,
	presetId: number,
): PromptPresetRecipe | undefined => {
	const db = connect(database);
	return presetRecipeOf(readPromptPresetHeader(db, presetId), db);
};

/** @approved
 * The selected recipe per Conversation for a set of Conversations, read in
 * bounded batches: the set costs one selection read and one block read per
 * batch instead of one recipe read each. Conversations without a selection
 * are absent.
 */
export const readConversationPromptPresetRecipes = (
	database: Database,
	conversationIds: readonly number[],
): Map<number, PromptPresetRecipe> => {
	const db = connect(database);
	const recipes = new Map<number, PromptPresetRecipe>();
	const selections = queryBatches([...new Set(conversationIds)]).flatMap((batch) => db
		.select({
			conversationId: conversationPromptPresetTable.conversation_id,
			presetId: conversationPromptPresetTable.prompt_preset_id,
		})
		.from(conversationPromptPresetTable)
		.where(inArray(conversationPromptPresetTable.conversation_id, batch))
		.all());
	if (selections.length === 0) return recipes;

	const presetIds = [...new Set(selections.map((selection) => selection.presetId))];
	const headers = new Map(
		queryBatches(presetIds).flatMap((batch) => db
			.select({ id: promptPresetTable.id, name: promptPresetTable.name })
			.from(promptPresetTable)
			.where(inArray(promptPresetTable.id, batch))
			.all())
			.map((header) => [header.id, header]),
	);
	const rowsByPreset = new Map<number, StoredPromptPresetBlock[]>();
	for (const batch of queryBatches(presetIds)) {
		// @approved
		//  SAFETY: prompt_preset_block_shape_check enforces this discriminated
		// row shape for every insert and update.
		const rows = db
			.select({
				presetId: promptPresetBlockTable.preset_id,
				...storedPromptPresetBlockSelection,
			})
			.from(promptPresetBlockTable)
			.where(inArray(promptPresetBlockTable.preset_id, batch))
			.orderBy(asc(promptPresetBlockTable.preset_id), asc(promptPresetBlockTable.position))
			.all() as (StoredPromptPresetBlock & { presetId: number })[];
		for (const { presetId, ...slot } of rows)
			rowsByPreset.set(presetId, [
				...(rowsByPreset.get(presetId) ?? []),
				slot,
			]);
	}

	for (const { conversationId, presetId } of selections) {
		const header = headers.get(presetId);
		if (header === undefined) continue;
		recipes.set(conversationId, {
			id: header.id,
			name: header.name,
			slots: toRecipeSlots(rowsByPreset.get(presetId) ?? []),
		});
	}
	return recipes;
};

/** @approved
 * The recipe a Conversation assembles through. Undefined only when the
 * Conversation itself does not exist; a Conversation always has a selection.
 */
export const readConversationPromptPresetRecipe = (
	database: Database,
	conversationId: number,
): PromptPresetRecipe | undefined => readConversationPromptPresetRecipeFromConnection(
	connect(database),
	conversationId,
);

/** @approved Read the selected recipe through an existing coherent database view. */
export const readConversationPromptPresetRecipeFromConnection = (
	db: PromptPresetDatabase,
	conversationId: number,
): PromptPresetRecipe | undefined => {
	const selection = db
		.select({ prompt_preset_id: conversationPromptPresetTable.prompt_preset_id })
		.from(conversationPromptPresetTable)
		.where(eq(conversationPromptPresetTable.conversation_id, conversationId))
		.get();
	if (selection === undefined) return undefined;
	return presetRecipeOf(readPromptPresetHeader(db, selection.prompt_preset_id), db);
};
