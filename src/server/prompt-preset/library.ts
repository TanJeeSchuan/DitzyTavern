import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { asc, count, eq } from "drizzle-orm";
import {
	conversationPromptPresetTable,
	promptPresetBlockTable,
	promptPresetTable,
} from "../database/schema";
import {
	promptPresetCreateCommand,
	type PromptPresetCommand,
	type PromptPresetDeletionResult,
	type PromptPresetSummary,
} from "../../shared/contract/prompt-preset";
import { Value } from "@sinclair/typebox/value";
import {
	DefaultPromptPresetNotRemovableError,
	InvalidPromptPresetCommandError,
	PromptPresetNotFoundError,
	StalePromptPresetRevisionError,
} from "./errors";
import { readDefaultPromptPresetId, type PromptPresetDatabase } from "./recipe";

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

const requireSummary = (db: PromptPresetDatabase, presetId: number): PromptPresetSummary => {
	const summary = listPresetSummaries(db).find((preset) => preset.id === presetId);
	if (summary === undefined) throw new PromptPresetNotFoundError(presetId);
	return summary;
};

const requireCommandName = (name: string): string => {
	const normalized = name.trim();
	if (normalized === "") {
		throw new InvalidPromptPresetCommandError("A Prompt Preset name is required.");
	}
	return normalized;
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
): PromptPresetSummary | PromptPresetDeletionResult {
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
			.set({ name: requireCommandName(command.name) })
			.where(eq(promptPresetTable.id, preset.id))
			.run();
		// ==[HUMAN APPROVED]== The rename is the only command that changes the guarded
		// source preset, so it alone advances the revision the next command
		// must carry.
		db.update(promptPresetTable)
			.set({ revision: preset.revision + 1 })
			.where(eq(promptPresetTable.id, preset.id))
			.run();
		return requireSummary(db, preset.id);
	});

	return execute.immediate();
}
