import type { Database } from "bun:sqlite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	conversationPromptPresetTable,
	promptPresetBlockTable,
	promptPresetTable,
} from "../database/schema";
import { Type } from "@sinclair/typebox";
import {
	promptOutgoingRole,
	promptPresetBlockReference,
	type PromptOutgoingRole,
	type PromptPresetBlockReference,
	type PromptPresetRecipe,
} from "../../shared/contract/prompt-preset";
import { PromptPresetNotFoundError } from "./errors";
import { Value } from "@sinclair/typebox/value";

const connect = (database: Database) => drizzle(database);
export type PromptPresetDatabase = ReturnType<typeof connect>;

class PromptPresetNotInitializedError extends Error {
	constructor() {
		super("The Default Prompt Preset is missing from the preset library.");
		this.name = "PromptPresetNotInitializedError";
	}
}

// ==[HUMAN APPROVED]== A stored slot whose reference is outside the supported vocabulary cannot
// be assembled and cannot be shown; failing here names the offending row
// instead of silently dropping content from every later Generation.
const requireReference = (value: string, presetId: number): PromptPresetBlockReference => {
	if (!Value.Check(promptPresetBlockReference, value)) {
		throw new Error(
			`Prompt Preset ${presetId} references the unsupported block "${value}".`,
		);
	}
	return value;
};

// ==[HUMAN APPROVED]== Every Definition and authored-instruction occurrence stores the outgoing
// role it assembles with; a missing or unknown value cannot be presented, so
// fail naming the row instead of assembling a request the recipe never chose.
const requireOutgoingRole = (
	value: string | null,
	presetId: number,
	blockId: number,
	reference: string,
): PromptOutgoingRole => {
	if (Value.Check(promptOutgoingRole, value)) return value;
	throw new Error(
		`Prompt Preset ${presetId} block ${blockId} ("${reference}") has no supported outgoing role.`,
	);
};

// ==[HUMAN APPROVED]== Authored instruction text is required at the storage boundary, while an
// empty string remains valid authored content. A missing value is corrupt
// persisted state and must not be replaced with fabricated text.
const requireInstructionText = (
	value: string | null,
	field: "name" | "content",
	presetId: number,
	blockId: number,
): string => {
	if (Value.Check(Type.String(), value)) return value;
	throw new Error(
		`Prompt Preset ${presetId} block ${blockId} ("instruction") has no ${field}.`,
	);
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

// ==[HUMAN APPROVED]== Applies one Conversation's authoritative selection of a shared
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

const storedOccurrences = (
	db: PromptPresetDatabase,
	presetId: number,
): PromptPresetRecipe["slots"] => {
	const slots = db
		.select({
			id: promptPresetBlockTable.id,
			reference: promptPresetBlockTable.reference,
			enabled: promptPresetBlockTable.enabled,
			role: promptPresetBlockTable.role,
			name: promptPresetBlockTable.name,
			content: promptPresetBlockTable.content,
		})
		.from(promptPresetBlockTable)
		.where(eq(promptPresetBlockTable.preset_id, presetId))
		.orderBy(asc(promptPresetBlockTable.position))
		.all();
	return slots.map((slot) => {
		const reference = requireReference(slot.reference, presetId);
		if (reference === "history") {
			// ==[HUMAN APPROVED]== The history slot has no outgoing role of its own; its entries
			// carry the roles of their own Messages. A non-null persisted role is
			// invalid state rather than a value to silently discard.
			if (slot.role !== null) {
				throw new Error(
					`Prompt Preset ${presetId} block ${slot.id} ("history") has an outgoing role.`,
				);
			}
			return { id: slot.id, reference, enabled: slot.enabled };
		}
		if (reference === "instruction") {
			// ==[HUMAN APPROVED]== An authored instruction always stores its composed name, text,
			// and outgoing role. The stored value is never normalized or
			// flattened, including when its content is legitimately empty.
			return {
				id: slot.id,
				reference,
				enabled: slot.enabled,
				role: requireOutgoingRole(slot.role, presetId, slot.id, reference),
				name: requireInstructionText(slot.name, "name", presetId, slot.id),
				content: requireInstructionText(slot.content, "content", presetId, slot.id),
			};
		}
		return {
			id: slot.id,
			reference,
			enabled: slot.enabled,
			role: requireOutgoingRole(slot.role, presetId, slot.id, reference),
		};
	});
};

/**
 * ==[HUMAN APPROVED]== One preset's stored header row. Undefined when the preset does not
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

/** ==[HUMAN APPROVED]== One stored preset's recipe by identity. Undefined when the preset does not exist. */
export const readPromptPresetRecipe = (
	database: Database,
	presetId: number,
): PromptPresetRecipe | undefined => {
	const db = connect(database);
	return presetRecipeOf(readPromptPresetHeader(db, presetId), db);
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
	const selection = db
		.select({ prompt_preset_id: conversationPromptPresetTable.prompt_preset_id })
		.from(conversationPromptPresetTable)
		.where(eq(conversationPromptPresetTable.conversation_id, conversationId))
		.get();
	if (selection === undefined) return undefined;
	return presetRecipeOf(readPromptPresetHeader(db, selection.prompt_preset_id), db);
};
