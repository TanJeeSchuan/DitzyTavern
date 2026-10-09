import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { conversationPromptPresetTable, promptPresetBlockTable } from "../database/schema";
import { resequence } from "../database/resequence";
import {
	defaultOutgoingRoles,
	isSingleUseReference,
	singleUseReferenceLabels,
	type PromptPresetBlockPatch,
	type PromptBlockReference,
	type PromptOutgoingRole,
	type PromptPresetBlockOccurrence,
	type PromptPresetBlockReference,
	type PromptPresetRecipe,
	hasEnabledMemorySlot,
} from "../../shared/contract/prompt-preset";
import { readPromptPresetRecipe } from "./recipe";
import { PromptPresetNotFoundError } from "./errors";
import { refreshMemoryForConversation } from "../memory";

// @approved
//  The authoritative Prompt Preset recipe operations. Every operation
// persists the smallest change it names and returns the stored recipe as a
// fresh read, so a stale block draft can never overwrite separately saved
// ordering or toggles — there is no whole-recipe write to do it with.

export class PromptPresetBlockNotFoundError extends Error {
	readonly outcome = "not-found" as const;

	constructor(presetId: number, blockId: number) {
		super(`Prompt Preset ${presetId} has no block ${blockId}.`);
		this.name = "PromptPresetBlockNotFoundError";
	}
}

export class InvalidPromptPresetOperationError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };

	constructor(readonly reason: string) {
		super(reason);
		this.name = "InvalidPromptPresetOperationError";
	}
}

const assertNoSecondUniqueBlock = (reference: string, exists: boolean) => {
	if (isSingleUseReference(reference) && exists) throw new InvalidPromptPresetOperationError(`A Prompt Preset may contain at most one ${singleUseReferenceLabels[reference]} block.`);
};

const validateBlockPatches = (
	recipe: PromptPresetRecipe,
	patches: readonly PromptPresetBlockPatch[],
): void => {
	const occurrences = new Map(recipe.slots.map((slot) => [slot.id, slot]));
	const seen = new Set<number>();
	for (const patch of patches) {
		if (seen.has(patch.occurrenceId)) {
			throw new InvalidPromptPresetOperationError(
				`Occurrence ${patch.occurrenceId} is patched more than once.`,
			);
		}
		seen.add(patch.occurrenceId);
		const occurrence = occurrences.get(patch.occurrenceId);
		if (occurrence === undefined) {
			throw new InvalidPromptPresetOperationError(
				`Occurrence ${patch.occurrenceId} does not belong to this Prompt Preset.`,
			);
		}
		if (patch.type === "role" && occurrence.reference === "history") {
			throw new InvalidPromptPresetOperationError(
				"The history slot has no outgoing role of its own; its entries keep their Message roles.",
			);
		}
		if (patch.type === "content" && occurrence.reference !== "instruction") {
			throw new InvalidPromptPresetOperationError(
				"Only an authored instruction block has text to save; referenced blocks stay read-only here.",
			);
		}
	}
};

const applyBlockPatch = (
	db: Pick<RecipeDatabase, "update">,
	patch: PromptPresetBlockPatch,
): void => {
	if (patch.type === "enabled") {
		db.update(promptPresetBlockTable)
			.set({ enabled: patch.enabled })
			.where(eq(promptPresetBlockTable.id, patch.occurrenceId))
			.run();
		return;
	}
	if (patch.type === "role") {
		db.update(promptPresetBlockTable)
			.set(patch.enabled === undefined ? { role: patch.role } : { role: patch.role, enabled: patch.enabled })
			.where(eq(promptPresetBlockTable.id, patch.occurrenceId))
			.run();
		return;
	}
	db.update(promptPresetBlockTable)
		.set(patch.enabled === undefined
			? { name: patch.name, content: patch.content, role: patch.role }
			: { name: patch.name, content: patch.content, role: patch.role, enabled: patch.enabled })
		.where(eq(promptPresetBlockTable.id, patch.occurrenceId))
		.run();
};

type RecipeDatabase = ReturnType<typeof drizzle>;

// @approved
//  The one construction site for a stored occurrence row. The preset id, the
//  placement the op names, the storage split (history stores no role; only an
//  authored instruction stores a name and text), and the outgoing role a new
//  slot starts with are decided here, so each op supplies only its own slot
//  data. The stored id comes back so an op that repositions the new row can
//  splice it into the order it returns.
const insertOccurrence = (
	db: Pick<RecipeDatabase, "insert">,
	presetId: number,
	position: number,
	occurrence: {
		reference: PromptPresetBlockReference;
		enabled: boolean;
		role?: PromptOutgoingRole;
		name?: string;
		content?: string;
	},
): number => {
	const { reference } = occurrence;
	const role = reference === "history"
		? null
		: occurrence.role ?? (reference === "instruction" ? "system" : defaultOutgoingRoles[reference]);
	return db
		.insert(promptPresetBlockTable)
		.values({
			preset_id: presetId,
			position,
			reference,
			enabled: occurrence.enabled,
			role,
			name: reference === "instruction" ? occurrence.name : null,
			content: reference === "instruction" ? occurrence.content : null,
		})
		.returning({ id: promptPresetBlockTable.id })
		.get()!.id;
};

const readRequiredRecipe = (database: Database, presetId: number): PromptPresetRecipe => {
	const recipe = readPromptPresetRecipe(database, presetId);
	if (recipe === undefined) throw new PromptPresetNotFoundError(presetId);
	return recipe;
};

const requireOccurrence = (
	recipe: PromptPresetRecipe,
	presetId: number,
	blockId: number,
): PromptPresetBlockOccurrence => {
	const occurrence = recipe.slots.find((slot) => slot.id === blockId);
	if (occurrence === undefined) throw new PromptPresetBlockNotFoundError(presetId, blockId);
	return occurrence;
};

// @approved
//  Memory re-tailing is decided from the operation's own two reads: the
//  authoritative recipe before the mutation and the single fresh read after
//  it. An operation that cannot move the Memory slot costs no extra read to
//  prove it.
const refreshSelectedMemoryTails = (
	database: Database,
	presetId: number,
	before: PromptPresetRecipe,
	after: PromptPresetRecipe,
): void => {
	if (hasEnabledMemorySlot(before.slots) === hasEnabledMemorySlot(after.slots)) return;
	const selected = drizzle(database)
		.select({ conversation_id: conversationPromptPresetTable.conversation_id })
		.from(conversationPromptPresetTable)
		.where(eq(conversationPromptPresetTable.prompt_preset_id, presetId))
		.all();
	for (const { conversation_id: conversationId } of selected) refreshMemoryForConversation(database, conversationId);
};

// @approved
//  One transactional boundary for every occurrence-addressed write: the
//  recipe is read once before the mutation, the mutation returns the new
//  dense order only when it moved one, and the single post-write read is both
//  the response and the Memory-toggle diff. The occurrence an operation
//  addresses must belong to the preset before any of its statements run.
const withRecipe = (
	database: Database,
	presetId: number,
	mutate: (db: RecipeDatabase, recipe: PromptPresetRecipe) => readonly number[] | undefined,
): PromptPresetRecipe => {
	const db = drizzle(database);
	return database.transaction(() => {
		const before = readRequiredRecipe(database, presetId);
		const order = mutate(db, before);
		if (order !== undefined) resequence(db, promptPresetBlockTable, promptPresetBlockTable.preset_id, presetId, order);
		const after = readRequiredRecipe(database, presetId);
		refreshSelectedMemoryTails(database, presetId, before, after);
		return after;
	}).immediate();
};

/** @approved
 * Saves all occurrence-addressed editor patches as one transaction. Every patch is checked
 * against the same authoritative recipe before the first write, so an invalid later patch
 * cannot leave earlier edits behind.
 */
export const savePromptPresetBlockPatches = (
	database: Database,
	presetId: number,
	patches: readonly PromptPresetBlockPatch[],
): PromptPresetRecipe =>
	withRecipe(database, presetId, (db, recipe) => {
		validateBlockPatches(recipe, patches);
		patches.forEach((patch) => applyBlockPatch(db, patch));
	});

/** Adds one reference with its default role; Author Note follows the last history slot. */
export const addPromptPresetBlock = (
	database: Database,
	presetId: number,
	reference: PromptBlockReference,
): PromptPresetRecipe =>
	withRecipe(database, presetId, (db, recipe) => {
		assertNoSecondUniqueBlock(reference, recipe.slots.some((slot) => slot.reference === reference));
		const ordered = recipe.slots.map((slot) => slot.id);
		const inserted = insertOccurrence(db, presetId, ordered.length + 1, { reference, enabled: true });
		if (reference !== "author-note") return;
		const historyIndex = recipe.slots.findLastIndex((slot) => slot.reference === "history");
		ordered.splice(historyIndex === -1 ? ordered.length : historyIndex + 1, 0, inserted);
		return ordered;
	});

/** @approved Appends one blank authored instruction occurrence. The name, text, and
 * outgoing role are authored through the block editor's Save boundary; the
 * defaults are a valid, empty-contributing starting state and never a
 * whole-recipe write. */
export const addPromptPresetInstruction = (
	database: Database,
	presetId: number,
): PromptPresetRecipe =>
	withRecipe(database, presetId, (db, recipe) => {
		insertOccurrence(db, presetId, recipe.slots.length + 1, {
			reference: "instruction",
			enabled: true,
			name: "Instruction",
			content: "",
		});
	});

/** @approved Moves one occurrence to a one-based position, shifting the rest. */
export const movePromptPresetBlock = (
	database: Database,
	presetId: number,
	blockId: number,
	toPosition: number,
): PromptPresetRecipe =>
	withRecipe(database, presetId, (_db, recipe) => {
		requireOccurrence(recipe, presetId, blockId);
		const ordered = recipe.slots.map((slot) => slot.id);
		if (toPosition < 1 || toPosition > ordered.length) {
			throw new InvalidPromptPresetOperationError(
				`Position ${toPosition} is outside the recipe's ${ordered.length} slots.`,
			);
		}
		const without = ordered.filter((id) => id !== blockId);
		without.splice(toPosition - 1, 0, blockId);
		return without;
	});

/** @approved Enables or disables one occurrence without moving it. */
export const setPromptPresetBlockEnabled = (
	database: Database,
	presetId: number,
	blockId: number,
	enabled: boolean,
): PromptPresetRecipe =>
	withRecipe(database, presetId, (db, recipe) => {
		requireOccurrence(recipe, presetId, blockId);
		db.update(promptPresetBlockTable)
			.set({ enabled })
			.where(eq(promptPresetBlockTable.id, blockId))
			.run();
	});

/** @approved Duplicates one occurrence directly after it, copying reference, role,
 * enablement, and — for an authored instruction — its name and text. The
 * copy is a separate occurrence, so its text and role can be edited
 * independently afterward. */
export const duplicatePromptPresetBlock = (
	database: Database,
	presetId: number,
	blockId: number,
): PromptPresetRecipe =>
	withRecipe(database, presetId, (db, recipe) => {
		const original = requireOccurrence(recipe, presetId, blockId);
		assertNoSecondUniqueBlock(original.reference, true);
		const ordered = recipe.slots.map((slot) => slot.id);
		const copy = insertOccurrence(db, presetId, ordered.length + 1, original);
		ordered.splice(ordered.indexOf(blockId) + 1, 0, copy);
		return ordered;
	});

/** @approved Removes one occurrence; no slot is forced to remain. */
export const removePromptPresetBlock = (
	database: Database,
	presetId: number,
	blockId: number,
): PromptPresetRecipe =>
	withRecipe(database, presetId, (db, recipe) => {
		requireOccurrence(recipe, presetId, blockId);
		db.delete(promptPresetBlockTable)
			.where(eq(promptPresetBlockTable.id, blockId))
			.run();
		return recipe.slots.map((slot) => slot.id).filter((id) => id !== blockId);
	});
