import { MACRO_DATA_NAMESPACE } from "../../shared/variant-data-codecs";
import type { Database } from "bun:sqlite";
import { and, eq, max } from "drizzle-orm";
import {
	conversationDataTable,
	conversationPromptPresetTable,
	conversationTable,
	messageVariantDataTable,
	messageVariantTable,
	messageTable,
	promptPresetTable,
} from "../database/schema";
import { deriveMacroVariables, macroInitialValuePrefix, macroInitialValueKey, macroWritesToData, readMacroWrites } from "../prompt-macros";
import {
	isMacroValue,
	isMacroVariableName,
	type MacroValue,
	type MacroVariableWrite,
} from "../../shared/contract/macro-variable-write";
import type { MacroVariables } from "../../shared/contract/macro-variables";
import type { ConversationSummary } from "./types";
import type { ConversationDatabase } from "./internal";
import { readSelectedHistoryFromConnection } from "./selected-history";
import { readVariantData } from "./variant-data";
import {
	advanceConversationRevisionGuarded,
	requireConversationSummary,
	runConversationReadTransaction,
	runConversationTransaction,
} from "./commands/transaction";
import {
	ConversationNotFoundError,
	InvalidConversationCommandError,
	StaleConversationRevisionError,
} from "./errors";

export interface ReadMacroVariablesInput {
	promptPresetId?: number | undefined;
	position?: number | undefined;
}

export interface EditMacroVariablesInput {
	conversationId: number;
	expectedRevision: number;
	promptPresetId: number;
	position: number;
	operation: "set" | "delete";
	name: string;
	value?: MacroValue;
}

export interface EditedMacroVariables {
	conversation: ConversationSummary;
	variables: MacroVariables;
}

const readConversationPreset = (db: ConversationDatabase, conversationId: number) => {
	const selected = db
		.select({ id: conversationPromptPresetTable.prompt_preset_id })
		.from(conversationPromptPresetTable)
		.where(eq(conversationPromptPresetTable.conversation_id, conversationId))
		.get();
	if (selected === undefined) return undefined;
	return db
		.select({ id: promptPresetTable.id, name: promptPresetTable.name })
		.from(promptPresetTable)
		.where(eq(promptPresetTable.id, selected.id))
		.get();
};

const requireNumber = (value: number, label: string): number => {
	if (!Number.isInteger(value) || value < 0) {
		throw new InvalidConversationCommandError(`${label} must be a non-negative integer.`);
	}
	return value;
};

const requireMacroValue = (value: MacroValue | undefined): MacroValue => {
	if (value === undefined || !isMacroValue(value)) {
		throw new InvalidConversationCommandError("Macro Variable values must be JSON values.");
	}
	return value;
};

const readMacroVariablesFromConnection = (
	db: ConversationDatabase,
	conversationId: number,
	input: ReadMacroVariablesInput = {},
): MacroVariables | undefined => {
	const preset = readConversationPreset(db, conversationId);
	if (preset === undefined) return undefined;
	const presetId = input.promptPresetId ?? preset.id;
	if (!Number.isInteger(presetId) || presetId <= 0) {
		throw new InvalidConversationCommandError("Prompt Preset ID must be a positive integer.");
	}
	const requestedPreset = presetId === preset.id
		? preset
		: db
				.select({ id: promptPresetTable.id, name: promptPresetTable.name })
				.from(promptPresetTable)
				.where(eq(promptPresetTable.id, presetId))
				.get();
	if (requestedPreset === undefined) return undefined;
	const requestedPosition = input.position;
	if (requestedPosition !== undefined) requireNumber(requestedPosition, "History position");
	const history = readSelectedHistoryFromConnection(db, conversationId, {
		position: requestedPosition,
		conversationDataNamespace: MACRO_DATA_NAMESPACE,
		conversationDataKeyPrefix: macroInitialValuePrefix(presetId),
	});
	if (history === undefined) return undefined;
	const macroWrites = readVariantData(db, history.messages.flatMap((message) => message.variant === null ? [] : [message.variant.id]), ["macroWrites"]);
	const selectedVariants = history.messages.flatMap((message) => message.variant === null ? [] : [{
			selected: true as const,
			macroWrites: macroWrites.get(message.variant.id)?.macroWrites ?? [],
			messageId: message.id,
			messagePosition: message.position,
			variantId: message.variant.id,
			variantPosition: message.variant.position,
		}]);
	const targetVariant = selectedVariants.at(-1);
	const variables = deriveMacroVariables({ initialData: history.initialData, presetId, selectedVariants });
	return {
		conversationId,
		promptPresetId: presetId,
		promptPresetName: requestedPreset.name,
		position: history.position,
		target: targetVariant === undefined
			? { type: "initial" }
			: {
				type: "variant",
				messageId: targetVariant.messageId,
				messagePosition: targetVariant.messagePosition,
				variantId: targetVariant.variantId,
				variantPosition: targetVariant.variantPosition,
			},
		variables,
	};
};

export const readMacroVariables = (
	database: Database,
	conversationId: number,
	input: ReadMacroVariablesInput = {},
): MacroVariables | undefined => runConversationReadTransaction(
	database,
	(db) => readMacroVariablesFromConnection(db, conversationId, input),
);

export const editMacroVariables = (database: Database, input: EditMacroVariablesInput): EditedMacroVariables =>
	runConversationTransaction(database, (db) => {
		const conversation = db
			.select({ revision: conversationTable.revision })
			.from(conversationTable)
			.where(eq(conversationTable.id, input.conversationId))
			.get();
		if (conversation === undefined) throw new ConversationNotFoundError(input.conversationId);
		if (conversation.revision !== input.expectedRevision) {
			throw new StaleConversationRevisionError(input.expectedRevision, conversation.revision);
		}
		if (!Number.isInteger(input.promptPresetId) || input.promptPresetId <= 0) {
			throw new InvalidConversationCommandError("Prompt Preset ID must be a positive integer.");
		}
		if (!isMacroVariableName(input.name)) {
			throw new InvalidConversationCommandError("Macro Variable names must start with a letter and contain only letters, numbers, underscores, or hyphens.");
		}
		const preset = readConversationPreset(db, input.conversationId);
		if (preset === undefined) throw new InvalidConversationCommandError("The Conversation has no selected Prompt Preset.");
		if (preset.id !== input.promptPresetId) {
			throw new InvalidConversationCommandError("Macro Variables can only be edited for the active Prompt Preset.");
		}
		requireNumber(input.position, "History position");
		const lastPosition = db
			.select({ value: max(messageTable.position) })
			.from(messageTable)
			.where(eq(messageTable.conversation_id, input.conversationId))
			.get()?.value ?? 0;
		if (input.position > lastPosition) {
			throw new InvalidConversationCommandError(`History position ${input.position} is beyond the end of this Conversation.`);
		}
		const write: MacroVariableWrite = input.operation === "set"
			? { name: input.name, operation: "set", value: requireMacroValue(input.value) }
			: { name: input.name, operation: "delete" as const, value: undefined };
		if (input.position === 0) {
			const key = macroInitialValueKey(input.promptPresetId, input.name);
			if (write.operation === "set") {
				const value = JSON.stringify(requireMacroValue(write.value));
				db.insert(conversationDataTable)
					.values({
						conversation_id: input.conversationId,
						namespace: MACRO_DATA_NAMESPACE,
						key,
						value,
					})
					.onConflictDoUpdate({
						target: [conversationDataTable.conversation_id, conversationDataTable.namespace, conversationDataTable.key],
						set: { value },
					})
					.run();
			} else {
				db.delete(conversationDataTable)
					.where(and(
						eq(conversationDataTable.conversation_id, input.conversationId),
						eq(conversationDataTable.namespace, MACRO_DATA_NAMESPACE),
						eq(conversationDataTable.key, key),
					))
					.run();
			}
		} else {
			const message = db
				.select({ id: messageTable.id })
				.from(messageTable)
				.where(and(
					eq(messageTable.conversation_id, input.conversationId),
					eq(messageTable.position, input.position),
				))
				.get();
			if (message === undefined) throw new InvalidConversationCommandError("The selected history position has no Message.");
			const variant = db
				.select({ id: messageVariantTable.id })
				.from(messageVariantTable)
				.where(and(eq(messageVariantTable.message_id, message.id), eq(messageVariantTable.selected, true)))
				.get();
			if (variant === undefined) throw new InvalidConversationCommandError("The selected history position has no selected Variant.");
			const stored = readVariantData(db, [variant.id], ["macroWrites"]).get(variant.id)?.macroWrites ?? [];
			const entries = macroWritesToData(input.promptPresetId, [...readMacroWrites(stored, input.promptPresetId), write]);
			db.insert(messageVariantDataTable)
				.values(entries.map((entry) => ({ message_variant_id: variant.id, ...entry })))
				.onConflictDoUpdate({
					target: [
						messageVariantDataTable.message_variant_id,
						messageVariantDataTable.namespace,
						messageVariantDataTable.key,
					],
					set: { value: entries[0]!.value },
				})
				.run();
		}
		advanceConversationRevisionGuarded(db, input.conversationId, input.expectedRevision, conversation.revision);
		const variables = readMacroVariablesFromConnection(db, input.conversationId, {
			promptPresetId: input.promptPresetId,
			position: input.position,
		});
		if (variables === undefined) throw new InvalidConversationCommandError("The Macro Variables read disappeared during the edit.");
		return {
			conversation: requireConversationSummary(db, input.conversationId),
			variables,
		};
	});
