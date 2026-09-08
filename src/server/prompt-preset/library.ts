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
	promptPresetCreateCommand,
	type SillyTavernImportPreview,
	type SillyTavernJsonValue,
	type NativePromptPreset,
	type PromptPresetCommand,
	type PromptPresetDeletionResult,
	type PromptPresetRecipe,
	type PromptPresetSummary,
} from "../../shared/contract/prompt-preset";
import { Value } from "@sinclair/typebox/value";
import {
	DefaultPromptPresetNotRemovableError,
	InvalidPromptPresetCommandError,
	PromptPresetDeletionImpactChangedError,
	PromptPresetNotFoundError,
	StalePromptPresetRevisionError,
} from "./errors";
import {
	readDefaultPromptPresetId,
	readPromptPresetRecipe,
	type PromptPresetDatabase,
} from "./recipe";
import {
	importSillyTavernPromptPreset as convertSillyTavernPromptPreset,
} from "./sillytavern";
import { savePromptPresetBlockPatches } from "./blocks";

// ==[HUMAN APPROVED]== The Prompt Preset library is a Character Library sibling: one
// revisioned list of named recipes whose deletion impact (the
// affected-Conversation count) rides every authoritative read. The Default
// preset is an ordinary entry except that deleting it is refused.
export const listPromptPresets = (database: Database): PromptPresetSummary[] =>
	listPresetSummaries(connect(database));

const connect = (database: Database): PromptPresetDatabase => drizzle(database);

const listPresetSummaries = (db: PromptPresetDatabase): PromptPresetSummary[] => {
	const presets = db
		.select({
			id: promptPresetTable.id,
			name: promptPresetTable.name,
			revision: promptPresetTable.revision,
			is_default: promptPresetTable.is_default,
		})
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
	return presets.map((preset) => ({
		id: preset.id,
		name: preset.name,
		revision: preset.revision,
		isDefault: preset.is_default,
		conversationCount: totals.get(preset.id) ?? 0,
	}));
};

// ==[HUMAN APPROVED]== Reads one preset's summary with its deletion impact (the
// Conversation selections currently pointing at it) inside the caller's
// transaction, so conflicts and results name exactly what a command saw.
const requireSummary = (db: PromptPresetDatabase, presetId: number): PromptPresetSummary => {
	const preset = db
		.select({
			id: promptPresetTable.id,
			name: promptPresetTable.name,
			revision: promptPresetTable.revision,
			is_default: promptPresetTable.is_default,
		})
		.from(promptPresetTable)
		.where(eq(promptPresetTable.id, presetId))
		.get();
	if (preset === undefined) throw new PromptPresetNotFoundError(presetId);
	const selection = db
		.select({ total: count() })
		.from(conversationPromptPresetTable)
		.where(eq(conversationPromptPresetTable.prompt_preset_id, presetId))
		.get();
	return {
		id: preset.id,
		name: preset.name,
		revision: preset.revision,
		isDefault: preset.is_default,
		conversationCount: selection?.total ?? 0,
	};
};

const requireCommandName = (name: string): string => {
	const normalized = name.trim();
	if (normalized === "") {
		throw new InvalidPromptPresetCommandError("A Prompt Preset name is required.");
	}
	return normalized;
};

// ==[HUMAN APPROVED]== Native export is projected from the stored recipe, not from a selected
// Conversation. Occurrence ids are local database identity and are omitted so
// reimport always creates fresh independent rows; referenced slots carry no
// resolved Participant or history content.
export const readNativePromptPreset = (
	database: Database,
	presetId: number,
): NativePromptPreset | undefined => {
	const recipe = readPromptPresetRecipe(database, presetId);
	if (recipe === undefined) return undefined;
	return {
		name: recipe.name,
		slots: recipe.slots.map((slot) => {
			if (slot.reference === "history") {
				return { reference: slot.reference, enabled: slot.enabled };
			}
			if (slot.reference === "instruction") {
				return {
					reference: slot.reference,
					enabled: slot.enabled,
					role: slot.role,
					name: slot.name,
					content: slot.content,
				};
			}
			return { reference: slot.reference, enabled: slot.enabled, role: slot.role };
		}),
	};
};

// ==[HUMAN APPROVED]== Native import validates the complete recipe before the transaction
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
	const db = connect(database);
	const execute = database.transaction(() => {
		const inserted = db
			.insert(promptPresetTable)
			.values({ name })
			.returning({ id: promptPresetTable.id })
			.get();
		if (inserted === undefined) throw new Error("The native Prompt Preset could not be imported.");
		if (native.slots.length > 0) {
			const rows = native.slots.map((slot, index) => {
				const row = {
					preset_id: inserted.id,
					position: index + 1,
					reference: slot.reference,
					enabled: slot.enabled,
					role: slot.reference === "history" ? null : slot.role,
				};
				return slot.reference === "instruction"
					? { ...row, name: slot.name, content: slot.content }
					: row;
			});
			db.insert(promptPresetBlockTable)
				.values(rows)
				.run();
		}
		return requireSummary(db, inserted.id);
	});
	return execute.immediate();
};

// ==[HUMAN APPROVED]== SillyTavern conversion completes before the native importer starts its
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

// ==[HUMAN APPROVED]== Executes one revisioned library command atomically. Every mutation
// except creation requires the expected revision; a rename advances it
// exactly once, while duplicating writes an independent preset without
// touching the guarded source. Confirmed deletion reassigns every
// Conversation that selected the preset to Default in the same transaction
// before the preset row (and its blocks) goes away, so no selection is ever
// left dangling.
export function executePromptPresetCommand(
	database: Database,
	command: PromptPresetCommand,
): PromptPresetSummary | PromptPresetDeletionResult | PromptPresetRecipe {
	if (command.type === "save-block-patches") {
		return savePromptPresetBlockPatches(database, command.presetId, command.patches);
	}
	if (Value.Check(promptPresetCreateCommand, command)) {
		const db = connect(database);
		const create = database.transaction(() => {
			const inserted = db
				.insert(promptPresetTable)
				.values({ name: requireCommandName(command.name) })
				.returning({ id: promptPresetTable.id })
				.get();
			if (inserted === undefined) throw new Error("The Prompt Preset could not be created.");
			return requireSummary(db, inserted.id);
		});
		return create.immediate();
	}

	const db = connect(database);
	const execute = database.transaction(() => {
		const preset = requireSummary(db, command.presetId);
		if (preset.revision !== command.expectedRevision) {
			throw new StalePromptPresetRevisionError(
				preset.id,
				command.expectedRevision,
				preset.revision,
				preset,
			);
		}

		if (command.type === "delete") {
			if (preset.isDefault) throw new DefaultPromptPresetNotRemovableError();
			// ==[HUMAN APPROVED]== The confirmed deletion impact is compared against the
			// authoritative count in the same transaction that reassigns selections,
			// so a count the author never saw can never be deleted.
			if (preset.conversationCount !== command.expectedConversationCount) {
				throw new PromptPresetDeletionImpactChangedError(
					command.expectedConversationCount,
					preset.conversationCount,
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
			return {
				presetId: preset.id,
				reassignedConversationCount: reassigned.length,
			} satisfies PromptPresetDeletionResult;
		}

		if (command.type === "duplicate") {
			const inserted = db
				.insert(promptPresetTable)
				.values({ name: requireCommandName(command.name) })
				.returning({ id: promptPresetTable.id })
				.get();
			if (inserted === undefined) throw new Error("The Prompt Preset could not be duplicated.");
			const blocks = db
				.select({
					position: promptPresetBlockTable.position,
					reference: promptPresetBlockTable.reference,
					enabled: promptPresetBlockTable.enabled,
					role: promptPresetBlockTable.role,
					name: promptPresetBlockTable.name,
					content: promptPresetBlockTable.content,
				})
				.from(promptPresetBlockTable)
				.where(eq(promptPresetBlockTable.preset_id, preset.id))
				.orderBy(asc(promptPresetBlockTable.position))
				.all();
			if (blocks.length > 0) {
				db.insert(promptPresetBlockTable)
					.values(blocks.map((block) => ({ preset_id: inserted.id, ...block })))
					.run();
			}
			return requireSummary(db, inserted.id);
		}

		db.update(promptPresetTable)
			// ==[HUMAN APPROVED]== The rename is the only command that changes the guarded
			// source preset, so it alone advances the revision the next command
			// must carry.
			.set({ name: requireCommandName(command.name), revision: preset.revision + 1 })
			.where(eq(promptPresetTable.id, preset.id))
			.run();
		return requireSummary(db, preset.id);
	});

	return execute.immediate();
}
