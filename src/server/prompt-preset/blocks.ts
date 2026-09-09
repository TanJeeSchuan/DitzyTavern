import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { promptPresetBlockTable } from "../database/schema";
import {
	defaultOutgoingRoles,
	promptPresetBlockPatch,
	type PromptPresetBlockPatch,
	type PromptBlockReference,
	type PromptPresetBlockOccurrence,
	type PromptPresetRecipe,
} from "../../shared/contract/prompt-preset";
import { readPromptPresetRecipe } from "./recipe";
import { PromptPresetNotFoundError } from "./errors";

// ==[HUMAN APPROVED]== The authoritative Prompt Preset recipe operations. Every operation
// persists the smallest change it names and returns the stored recipe as a
// fresh read, so a stale block draft can never overwrite separately saved
// ordering or toggles — there is no whole-recipe write to do it with.

export class PromptPresetBlockNotFoundError extends Error {
	constructor(presetId: number, blockId: number) {
		super(`Prompt Preset ${presetId} has no block ${blockId}.`);
		this.name = "PromptPresetBlockNotFoundError";
	}
}

export class InvalidPromptPresetOperationError extends Error {
	constructor(readonly reason: string) {
		super(reason);
		this.name = "InvalidPromptPresetOperationError";
	}
}

const validateBlockPatches = (
	recipe: PromptPresetRecipe,
	patches: readonly PromptPresetBlockPatch[],
): void => {
	const occurrences = new Map(recipe.slots.map((slot) => [slot.id, slot]));
	const seen = new Set<number>();
	for (const patch of patches) {
		if (!Value.Check(promptPresetBlockPatch, patch)) {
			throw new InvalidPromptPresetOperationError("The Prompt Preset block patch is invalid.");
		}
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
	tx: Pick<RecipeDatabase, "update">,
	patch: PromptPresetBlockPatch,
): void => {
	if (patch.type === "role") {
		tx.update(promptPresetBlockTable)
			.set({ role: patch.role })
			.where(eq(promptPresetBlockTable.id, patch.occurrenceId))
			.run();
		return;
	}
	tx.update(promptPresetBlockTable)
		.set({ name: patch.name, content: patch.content, role: patch.role })
		.where(eq(promptPresetBlockTable.id, patch.occurrenceId))
		.run();
};

type RecipeDatabase = ReturnType<typeof drizzle>;

// ==[HUMAN APPROVED]== The stored position of every slot is a dense 1-based order, so a
// move target and a duplicate's neighbor stay meaningful. Renumbering goes
// through one offset pass first because `position` is unique per preset:
// every row briefly moves past the end, then takes its final place.
const renumber = (
	database: Pick<RecipeDatabase, "update">,
	presetId: number,
	orderedIds: readonly number[],
): void => {
	database
		.update(promptPresetBlockTable)
		.set({ position: sql`${promptPresetBlockTable.position} + 65536` })
		.where(eq(promptPresetBlockTable.preset_id, presetId))
		.run();
	orderedIds.forEach((id, index) => {
		database
			.update(promptPresetBlockTable)
			.set({ position: index + 1 })
			.where(eq(promptPresetBlockTable.id, id))
			.run();
	});
};

const orderedIdsOf = (
	database: Pick<RecipeDatabase, "select">,
	presetId: number,
): number[] =>
	database
		.select({ id: promptPresetBlockTable.id })
		.from(promptPresetBlockTable)
		.where(eq(promptPresetBlockTable.preset_id, presetId))
		.orderBy(asc(promptPresetBlockTable.position))
		.all()
		.map((row) => row.id);

const requireRecipe = (
	recipe: PromptPresetRecipe | undefined,
	presetId: number,
): PromptPresetRecipe => {
	if (recipe === undefined) throw new PromptPresetNotFoundError(presetId);
	return recipe;
};

const requireBlock = (
	database: Database,
	presetId: number,
	blockId: number,
): PromptPresetRecipe => {
	const recipe = requireRecipe(readPromptPresetRecipe(database, presetId), presetId);
	if (!recipe.slots.some((slot) => slot.id === blockId)) {
		throw new PromptPresetBlockNotFoundError(presetId, blockId);
	}
	return recipe;
};

/** ==[HUMAN APPROVED]==
 * Saves all occurrence-addressed editor patches as one transaction. Every patch is checked
 * against the same authoritative recipe before the first write, so an invalid later patch
 * cannot leave earlier edits behind.
 */
export const savePromptPresetBlockPatches = (
	database: Database,
	presetId: number,
	patches: readonly PromptPresetBlockPatch[],
): PromptPresetRecipe => {
	const db = drizzle(database);
	return db.transaction((tx) => {
		const recipe = requireRecipe(readPromptPresetRecipe(database, presetId), presetId);
		validateBlockPatches(recipe, patches);
		patches.forEach((patch) => applyBlockPatch(tx, patch));
		return requireRecipe(readPromptPresetRecipe(database, presetId), presetId);
	});
};

// ==[HUMAN APPROVED]== One transactional boundary for the occurrence-addressed writes: the
// occurrence must belong to the preset before any statement of the operation
// runs, the write sees the verified occurrence, and the response is the
// stored recipe as a fresh read.
const writePromptPresetBlock = (
	database: Database,
	presetId: number,
	blockId: number,
	write: (
		tx: Pick<RecipeDatabase, "select" | "update" | "insert" | "delete">,
		occurrence: PromptPresetBlockOccurrence,
	) => void,
): PromptPresetRecipe =>
	drizzle(database).transaction((tx) => {
		const occurrence = requireBlock(database, presetId, blockId)
			.slots.find((slot) => slot.id === blockId);
		if (occurrence === undefined) {
			throw new PromptPresetBlockNotFoundError(presetId, blockId);
		}
		write(tx, occurrence);
		return requireRecipe(readPromptPresetRecipe(database, presetId), presetId);
	});

/** ==[HUMAN APPROVED]== Appends one reference occurrence with its default outgoing role. */
export const addPromptPresetBlock = (
	database: Database,
	presetId: number,
	reference: PromptBlockReference,
): PromptPresetRecipe => {
	requireRecipe(readPromptPresetRecipe(database, presetId), presetId);
	const db = drizzle(database);
	return db.transaction((tx) => {
		const count = orderedIdsOf(tx, presetId).length;
		tx.insert(promptPresetBlockTable)
			.values({
				preset_id: presetId,
				position: count + 1,
				reference,
				enabled: true,
				role: reference === "history" ? null : defaultOutgoingRoles[reference],
			})
			.run();
		return requireRecipe(readPromptPresetRecipe(database, presetId), presetId);
	});
};

/** ==[HUMAN APPROVED]== Appends one blank authored instruction occurrence. The name, text, and
 * outgoing role are authored through the block editor's Save boundary; the
 * defaults are a valid, empty-contributing starting state and never a
 * whole-recipe write. */
export const addPromptPresetInstruction = (
	database: Database,
	presetId: number,
): PromptPresetRecipe => {
	requireRecipe(readPromptPresetRecipe(database, presetId), presetId);
	const db = drizzle(database);
	return db.transaction((tx) => {
		const count = orderedIdsOf(tx, presetId).length;
		tx.insert(promptPresetBlockTable)
			.values({
				preset_id: presetId,
				position: count + 1,
				reference: "instruction",
				enabled: true,
				role: "system",
				name: "Instruction",
				content: "",
			})
			.run();
		return requireRecipe(readPromptPresetRecipe(database, presetId), presetId);
	});
};

/** ==[HUMAN APPROVED]== Moves one occurrence to a one-based position, shifting the rest. */
export const movePromptPresetBlock = (
	database: Database,
	presetId: number,
	blockId: number,
	toPosition: number,
): PromptPresetRecipe =>
	writePromptPresetBlock(database, presetId, blockId, (tx) => {
		const ordered = orderedIdsOf(tx, presetId);
		if (toPosition < 1 || toPosition > ordered.length) {
			throw new InvalidPromptPresetOperationError(
				`Position ${toPosition} is outside the recipe's ${ordered.length} slots.`,
			);
		}
		const without = ordered.filter((id) => id !== blockId);
		without.splice(toPosition - 1, 0, blockId);
		renumber(tx, presetId, without);
	});

/** ==[HUMAN APPROVED]== Enables or disables one occurrence without moving it. */
export const setPromptPresetBlockEnabled = (
	database: Database,
	presetId: number,
	blockId: number,
	enabled: boolean,
): PromptPresetRecipe =>
	writePromptPresetBlock(database, presetId, blockId, (tx) => {
		tx.update(promptPresetBlockTable)
			.set({ enabled })
			.where(eq(promptPresetBlockTable.id, blockId))
			.run();
	});

/** ==[HUMAN APPROVED]== Duplicates one occurrence directly after it, copying reference, role,
 * enablement, and — for an authored instruction — its name and text. The
 * copy is a separate occurrence, so its text and role can be edited
 * independently afterward. */
export const duplicatePromptPresetBlock = (
	database: Database,
	presetId: number,
	blockId: number,
): PromptPresetRecipe =>
	writePromptPresetBlock(database, presetId, blockId, (tx, original) => {
		// ==[HUMAN APPROVED]== The copy's row is placed by renumbering, not by its stored
		// position: the ordered list is read before the insert so the copy is
		// spliced in exactly once, right after the original.
		const ordered = orderedIdsOf(tx, presetId);
		// ==[HUMAN APPROVED]== Authored instruction rows carry their own name and text;
		// referenced occurrences store none, so only the instruction branch
		// contributes them to the copy.
		const duplicatedRow: typeof promptPresetBlockTable.$inferInsert = {
			preset_id: presetId,
			position: ordered.length + 1,
			reference: original.reference,
			enabled: original.enabled,
			role: original.reference === "history" ? null : original.role,
		};
		if (original.reference === "instruction") {
			duplicatedRow.name = original.name;
			duplicatedRow.content = original.content;
		}
		const inserted = tx
			.insert(promptPresetBlockTable)
			.values(duplicatedRow)
			.returning({ id: promptPresetBlockTable.id })
			.get();
		if (inserted === undefined) {
			throw new Error("The duplicated Prompt Preset block could not be stored.");
		}
		const withCopy = [...ordered];
		withCopy.splice(withCopy.indexOf(blockId) + 1, 0, inserted.id);
		renumber(tx, presetId, withCopy);
	});

/** ==[HUMAN APPROVED]== Removes one occurrence; no slot is forced to remain. */
export const removePromptPresetBlock = (
	database: Database,
	presetId: number,
	blockId: number,
): PromptPresetRecipe =>
	writePromptPresetBlock(database, presetId, blockId, (tx) => {
		tx.delete(promptPresetBlockTable)
			.where(eq(promptPresetBlockTable.id, blockId))
			.run();
		renumber(tx, presetId, orderedIdsOf(tx, presetId));
	});
