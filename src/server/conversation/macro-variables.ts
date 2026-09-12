import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray, max } from "drizzle-orm";
import {
	conversationDataTable,
	conversationPromptPresetTable,
	conversationTable,
	messageTable,
	messageVariantDataTable,
	messageVariantTable,
	promptPresetTable,
} from "../database/schema";
import {
	deriveMacroVariables,
	macroInitialValuesToData,
	macroWritesToData,
	nextMacroWriteSequence,
} from "../prompt-macros";
import { isMacroValue, isMacroVariableName, type MacroValue } from "../../shared/contract/macro-variables";
import type {
	MacroVariables as SharedMacroVariables,
} from "../../shared/contract/macro-variables";
import type { ConversationSummary } from "./types";
import { connectConversationDatabase, type ConversationDatabase } from "./internal";
import {
	advanceConversationRevisionGuarded,
	requireConversationSummary,
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

export type MacroVariablesRead = SharedMacroVariables;

export interface EditedMacroVariables {
	conversation: ConversationSummary;
	variables: MacroVariablesRead;
}

type MessageRow = { id: number; position: number };
type VariantRow = {
	id: number;
	message_id: number;
	position: number;
	selected: boolean;
};

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
): MacroVariablesRead | undefined => {
	const conversation = db
		.select({ id: conversationTable.id })
		.from(conversationTable)
		.where(eq(conversationTable.id, conversationId))
		.get();
	if (conversation === undefined) return undefined;
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

	const messages: MessageRow[] = db
		.select({ id: messageTable.id, position: messageTable.position })
		.from(messageTable)
		.where(eq(messageTable.conversation_id, conversationId))
		.orderBy(asc(messageTable.position))
		.all();
	const lastPosition = messages.at(-1)?.position ?? 0;
	const position = requestedPosition ?? lastPosition;
	if (position > lastPosition) {
		throw new InvalidConversationCommandError(
			`History position ${position} is beyond the end of this Conversation.`,
		);
	}
	const initialData = db
		.select({ namespace: conversationDataTable.namespace, key: conversationDataTable.key, value: conversationDataTable.value })
		.from(conversationDataTable)
		.where(eq(conversationDataTable.conversation_id, conversationId))
		.all();
	const history = messages.filter((message) => message.position <= position);
	const variants: VariantRow[] = history.length === 0
		? []
		: db
				.select({
					id: messageVariantTable.id,
					message_id: messageVariantTable.message_id,
					position: messageVariantTable.position,
					selected: messageVariantTable.selected,
				})
				.from(messageVariantTable)
				.where(inArray(messageVariantTable.message_id, history.map(({ id }) => id)))
				.orderBy(asc(messageVariantTable.message_id), asc(messageVariantTable.position))
				.all();
	const variantIds = variants.map(({ id }) => id);
	const dataRows = variantIds.length === 0
		? []
		: db
				.select({
					message_variant_id: messageVariantDataTable.message_variant_id,
					namespace: messageVariantDataTable.namespace,
					key: messageVariantDataTable.key,
					value: messageVariantDataTable.value,
				})
				.from(messageVariantDataTable)
				.where(inArray(messageVariantDataTable.message_variant_id, variantIds))
				.all();
	const dataByVariant = new Map<number, { namespace: string; key: string; value: string }[]>();
	for (const row of dataRows) {
		const entries = dataByVariant.get(row.message_variant_id) ?? [];
		entries.push({ namespace: row.namespace, key: row.key, value: row.value });
		dataByVariant.set(row.message_variant_id, entries);
	}
	const selectedVariants = history.flatMap((message) => {
		const selected = variants.find((variant) => variant.message_id === message.id && variant.selected);
		return selected === undefined
			? []
			: [{
					selected: true,
					data: dataByVariant.get(selected.id) ?? [],
					messageId: message.id,
					messagePosition: message.position,
					variantId: selected.id,
					variantPosition: selected.position,
				}];
	});
	const targetVariant = selectedVariants.at(-1);
	const variables = deriveMacroVariables({ initialData, presetId, selectedVariants });
	return {
		conversationId,
		promptPresetId: presetId,
		promptPresetName: requestedPreset.name,
		position,
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
): MacroVariablesRead | undefined =>
	readMacroVariablesFromConnection(connectConversationDatabase(database), conversationId, input);

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
		const write: import("../../shared/contract/macro-variables").MacroVariableWrite = input.operation === "set"
			? { name: input.name, operation: "set", value: requireMacroValue(input.value) }
			: { name: input.name, operation: "delete" as const, value: undefined };
		if (input.position === 0) {
			const entry = write.operation === "set"
				? macroInitialValuesToData(input.promptPresetId, new Map<string, MacroValue>([[input.name, requireMacroValue(write.value)]]))[0]
				: macroInitialValuesToData(input.promptPresetId, new Map([[input.name, null]]))[0];
			if (entry === undefined) throw new InvalidConversationCommandError("Macro Variable could not be encoded.");
			if (write.operation === "set") {
				db.insert(conversationDataTable)
					.values({ conversation_id: input.conversationId, ...entry })
					.onConflictDoUpdate({
						target: [conversationDataTable.conversation_id, conversationDataTable.namespace, conversationDataTable.key],
						set: { value: entry.value },
					})
					.run();
			} else {
				db.delete(conversationDataTable)
					.where(and(
						eq(conversationDataTable.conversation_id, input.conversationId),
						eq(conversationDataTable.namespace, entry.namespace),
						eq(conversationDataTable.key, entry.key),
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
			const rows = db
				.select({ namespace: messageVariantDataTable.namespace, key: messageVariantDataTable.key, value: messageVariantDataTable.value })
				.from(messageVariantDataTable)
				.where(eq(messageVariantDataTable.message_variant_id, variant.id))
				.all();
			const [entry] = macroWritesToData(input.promptPresetId, [write], nextMacroWriteSequence(rows, input.promptPresetId));
			if (entry === undefined) throw new InvalidConversationCommandError("Macro Variable write could not be encoded.");
			db.insert(messageVariantDataTable).values({ message_variant_id: variant.id, ...entry }).run();
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
