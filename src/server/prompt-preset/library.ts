import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { asc, count, eq } from "drizzle-orm";
import {
	conversationPromptPresetTable,
	promptPresetBlockTable,
	promptPresetTable,
} from "../database/schema";
import {
	nativePromptPreset,
	singleUseReferenceLabels,
	type SillyTavernImportPreview,
	type SillyTavernJsonValue,
	type NativePromptPreset,
	type PromptPresetCommand,
	type PromptPresetDeletionResult,
	type PromptPresetSummary,
} from "../../shared/contract/prompt-preset";
import { Value } from "@sinclair/typebox/value";
import {
	DefaultPromptPresetNotRemovableError,
	InvalidPromptPresetCommandError,
	PromptPresetDeletionImpactChangedError,
	PromptPresetNotFoundError,
} from "./errors";
import { guardRevision } from "../revision";
import {
	readDefaultPromptPresetId,
	readPromptPresetRecipe,
	promptPresetBlockSelection,
	type PromptPresetDatabase,
} from "./recipe";
import { refreshMemoryForConversation } from "../memory";
import {
	convertSillyTavernPromptPreset,
} from "./sillytavern";

// @approved
//  The Prompt Preset library is a Character Library sibling: one
// revisioned list of named recipes whose deletion impact (the
// affected-Conversation count) rides every authoritative read. The Default
// preset is an ordinary entry except that deleting it is refused.
export const listPromptPresets = (database: Database): PromptPresetSummary[] =>
	listPresetSummaries(connect(database));

const connect = (database: Database): PromptPresetDatabase => drizzle(database);

/** @approved Insert one library header row and return its id; the failure message
 * names the command that could not complete. */
const insertPresetHeader = (
	db: PromptPresetDatabase,
	name: string,
	verb: "created" | "duplicated",
): number => {
	const inserted = db
		.insert(promptPresetTable)
		.values({ name })
		.returning({ id: promptPresetTable.id })
		.get();
	if (inserted === undefined) throw new Error(`The Prompt Preset could not be ${verb}.`);
	return inserted.id;
};

// @approved
//  The one library-header selection and the one row-to-summary projection,
// shared by the list read and the in-transaction require read so a header
// field addition touches both callers through one declaration.
const presetHeaderSelection = {
	id: promptPresetTable.id,
	name: promptPresetTable.name,
	revision: promptPresetTable.revision,
	is_default: promptPresetTable.is_default,
};

const summaryOf = (
	preset: { id: number; name: string; revision: number; is_default: boolean },
	conversationCount: number,
): PromptPresetSummary => ({
	id: preset.id,
	name: preset.name,
	revision: preset.revision,
	isDefault: preset.is_default,
	conversationCount,
});

const listPresetSummaries = (db: PromptPresetDatabase): PromptPresetSummary[] => {
	const presets = db
		.select(presetHeaderSelection)
		.from(promptPresetTable)
		.orderBy(asc(promptPresetTable.id))
		.all();
	const selections = db
		.select({
			presetId: conversationPromptPresetTable.prompt_preset_id,
			total: count(),
		})
		.from(conversationPromptPresetTable)
		.groupBy(conversationPromptPresetTable.prompt_preset_id)
		.all();
	const totals = new Map(selections.map((entry) => [entry.presetId, entry.total]));
	return presets.map((preset) => summaryOf(preset, totals.get(preset.id) ?? 0));
};

// @approved
//  Reads one preset's summary with its deletion impact (the
// Conversation selections currently pointing at it) inside the caller's
// transaction, so conflicts and results name exactly what a command saw.
const requireSummary = (db: PromptPresetDatabase, presetId: number): PromptPresetSummary => {
	const preset = db
		.select(presetHeaderSelection)
		.from(promptPresetTable)
		.where(eq(promptPresetTable.id, presetId))
		.get();
	if (preset === undefined) throw new PromptPresetNotFoundError(presetId);
	const selection = db
		.select({ total: count() })
		.from(conversationPromptPresetTable)
		.where(eq(conversationPromptPresetTable.prompt_preset_id, presetId))
		.get();
	return summaryOf(preset, selection?.total ?? 0);
};

const requireCommandName = (name: string): string => {
	const normalized = name.trim();
	if (normalized === "") {
		throw new InvalidPromptPresetCommandError("A Prompt Preset name is required.");
	}
	return normalized;
};

// @approved
//  Native export is projected from the stored recipe, not from a selected
// Conversation. Occurrence ids are local database identity and are omitted so
// reimport always creates fresh independent rows; referenced slots carry no
// resolved Participant or history content.
export const readNativePromptPreset = (
	database: Database,
	presetId: number,
): NativePromptPreset | undefined => {
	const recipe = readPromptPresetRecipe(database, presetId);
	if (recipe === undefined) return undefined;
	// @approved
	//  Occurrence ids are local database identity and are omitted so reimport
	// always creates fresh independent rows; referenced slots carry no resolved
	// Participant or history content. The slot is already the canonical closed
	// slot shape, so the projection is one envelope strip.
	//  SAFETY: the strip result is exactly the wire slot (one id column
	// removed from the occurrence), and the recipe's declared promptPresetRecipe
	// wire schema validates every value this projection emits.
	return {
		name: recipe.name,
		slots: recipe.slots.map(({ id: _occurrenceId, ...slot }) => slot as NativePromptPreset["slots"][number]),
	};
};

// @approved
//  Native import validates the complete recipe before the transaction
// begins, then inserts a new non-Default library row and fresh occurrence rows
// together. No source identity or Conversation selection is carried across.
export const importNativePromptPreset = (
	database: Database,
	native: NativePromptPreset,
): PromptPresetSummary => {
	if (!Value.Check(nativePromptPreset, native)) {
		throw new InvalidPromptPresetCommandError("The native Prompt Preset JSON is invalid.");
	}
	const name = requireCommandName(native.name);
	for (const [reference, label] of Object.entries(singleUseReferenceLabels)) {
		if (native.slots.filter((slot) => slot.reference === reference).length > 1) throw new InvalidPromptPresetCommandError(`A Prompt Preset may contain at most one ${label} block.`);
	}
	const db = connect(database);
	const execute = database.transaction(() => {
		const insertedId = insertPresetHeader(db, name, "created");
		if (native.slots.length > 0) {
			const rows = native.slots.map((slot, index) => {
				const row: typeof promptPresetBlockTable.$inferInsert = {
					preset_id: insertedId,
					position: index + 1,
					reference: slot.reference,
					enabled: slot.enabled,
					role: slot.reference === "history" ? null : slot.role,
				};
				// @approved
				//  An authored instruction is the only slot that stores its
				// composed name and text.
				if (slot.reference === "instruction") {
					row.name = slot.name;
					row.content = slot.content;
				}
				return row;
			});
			db.insert(promptPresetBlockTable)
				.values(rows)
				.run();
		}
		return requireSummary(db, insertedId);
	});
	return execute.immediate();
};

// @approved
//  SillyTavern conversion completes before the native importer starts its
// transaction. A source that needs an order choice or contains invalid structure therefore
// cannot leave a partially-created library row behind.
export const importSillyTavernPromptPreset = (
	database: Database,
	source: SillyTavernJsonValue,
): SillyTavernImportPreview & { preset: PromptPresetSummary } => {
	const preview = convertSillyTavernPromptPreset(source);
	const preset = importNativePromptPreset(database, preview.native);
	return { ...preview, preset };
};

// @approved
//  Executes one revisioned library command atomically. Rename, duplicate and
// delete each require the expected revision; creation carries none because it
// addresses no existing preset. A rename advances the revision exactly once,
// while duplicating writes an independent preset without touching the guarded
// source. Block patches are occurrence-addressed and travel the recipe route,
// so every command this executor accepts is revision-guarded. Confirmed
// deletion reassigns every Conversation that selected the preset to Default in
// the same transaction before the preset row (and its blocks) goes away, so no
// selection is ever left dangling.
type PromptPresetCommandResult =
	| { kind: "preset"; preset: PromptPresetSummary }
	| { kind: "deleted"; result: PromptPresetDeletionResult };

export function executePromptPresetCommand(
	database: Database,
	command: PromptPresetCommand,
): PromptPresetCommandResult {
	// @approved
	//  One drizzle handle and one transaction serve every command this
	// executor accepts; the create path has no guarded source, so it is the
	// only member that skips the revision read.
	const db = connect(database);
	const execute = database.transaction((): PromptPresetCommandResult => {
		if (command.type === "create") {
			return { kind: "preset", preset: requireSummary(db, insertPresetHeader(db, requireCommandName(command.name), "created")) };
		}

		const preset = requireSummary(db, command.presetId);
		guardRevision("preset", command.expectedRevision, preset, () => preset);

		if (command.type === "delete") {
			if (preset.isDefault) throw new DefaultPromptPresetNotRemovableError();
			// @approved
			//  The confirmed deletion impact is compared against the
			// authoritative count in the same transaction that reassigns selections,
			// so a count the author never saw can never be deleted.
			if (preset.conversationCount !== command.expectedConversationCount) {
				throw new PromptPresetDeletionImpactChangedError(
					command.expectedConversationCount,
					preset,
				);
			}
			const defaultId = readDefaultPromptPresetId(db);
			const reassigned = db
				.update(conversationPromptPresetTable)
				.set({ prompt_preset_id: defaultId })
				.where(eq(conversationPromptPresetTable.prompt_preset_id, preset.id))
				.returning({ conversation_id: conversationPromptPresetTable.conversation_id })
				.all();
			db.delete(promptPresetTable).where(eq(promptPresetTable.id, preset.id)).run();
			for (const { conversation_id: conversationId } of reassigned) refreshMemoryForConversation(database, conversationId, "The selected Prompt Preset was deleted. Choose a preset with Memory and reset this source to process it again.");
			return {
				kind: "deleted",
				result: {
					presetId: preset.id,
					reassignedConversationCount: reassigned.length,
				},
			};
		}

		if (command.type === "duplicate") {
			const insertedId = insertPresetHeader(db, requireCommandName(command.name), "duplicated");
			const blocks = db
				.select(promptPresetBlockSelection)
				.from(promptPresetBlockTable)
				.where(eq(promptPresetBlockTable.preset_id, preset.id))
				.orderBy(asc(promptPresetBlockTable.position))
				.all();
			if (blocks.length > 0) {
				db.insert(promptPresetBlockTable)
					.values(blocks.map((block) => ({ preset_id: insertedId, ...block })))
					.run();
			}
			return { kind: "preset", preset: requireSummary(db, insertedId) };
		}

		db.update(promptPresetTable)
			// @approved
			//  The rename is the only command that changes the guarded
			// source preset, so it alone advances the revision the next command
			// must carry.
			.set({ name: requireCommandName(command.name), revision: preset.revision + 1 })
			.where(eq(promptPresetTable.id, preset.id))
			.run();
		return { kind: "preset", preset: requireSummary(db, preset.id) };
	});

	return execute.immediate();
}
