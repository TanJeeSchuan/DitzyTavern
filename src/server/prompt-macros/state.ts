import type { MacroValue, MacroVariableWrite } from "../../shared/prompt-macro-engine";
import type { ConversationDataEntry, ConversationVariantSnapshot } from "../conversation/types";
import type {
	MacroVariable as SharedMacroVariable,
	MacroVariableSource as SharedMacroVariableSource,
} from "../../shared/contract/macro-variables";
import {
	generationJsonObject,
	generationJsonString,
	parseGenerationJson,
} from "../../shared/generation-provenance";

// ==[HUMAN APPROVED]== Macro records have a domain-owned namespace. Generic data commands must
// not be able to manufacture or overwrite a write because state is derived from
// selected Variants rather than from one mutable Conversation map.
export const MACRO_DATA_NAMESPACE = "prompt-macro";

const initialPrefix = (presetId: number): string => `initial:${presetId}:`;
const writePrefix = (presetId: number): string => `write:${presetId}:`;
export const isMacroVariableName = (value: string): boolean => /^[A-Za-z](?:[\w-]*[\w])?$/.test(value);

export const isMacroValue = (value: unknown): value is MacroValue =>
	value === null ||
	typeof value === "string" ||
	typeof value === "number" && Number.isFinite(value) ||
	typeof value === "boolean" ||
	Array.isArray(value) && value.every(isMacroValue);

const encodedName = (name: string): string => encodeURIComponent(name);

const writeKey = (presetId: number, sequence: number): string =>
	`${writePrefix(presetId)}${String(sequence).padStart(12, "0")}`;

const writeValue = (write: MacroVariableWrite): string => {
	const record = { name: write.name, operation: write.operation };
	return JSON.stringify(write.operation === "set" ? { ...record, value: write.value } : record);
};

const parsedWrite = (
	entry: ConversationDataEntry,
	presetId: number,
): MacroVariableWrite | undefined => {
	const prefix = writePrefix(presetId);
	if (entry.namespace !== MACRO_DATA_NAMESPACE || !entry.key.startsWith(prefix)) return undefined;
	if (!/^\d+$/.test(entry.key.slice(prefix.length))) return undefined;
	const candidate = generationJsonObject(parseGenerationJson(entry.value, null));
	if (candidate === null) return undefined;
	const name = generationJsonString(candidate.name);
	const operation = generationJsonString(candidate.operation);
	if (name === null || !isMacroVariableName(name)) return undefined;
	if (operation === "delete") return { name, operation: "delete", value: undefined };
	if (operation !== "set" || !isMacroValue(candidate.value)) return undefined;
	return { name, operation: "set", value: candidate.value };
};

/** ==[HUMAN APPROVED]== Decode the crash-safe pending journal persisted on an Active Generation. */
export const parseMacroWrites = (value: string): MacroVariableWrite[] => {
	const parsed = parseGenerationJson(value, null);
	if (!Array.isArray(parsed)) throw new Error("The Active Generation has invalid persisted macro writes.");
	const writes: MacroVariableWrite[] = [];
	for (const candidate of parsed) {
		const entry = generationJsonObject(candidate);
		if (entry === null) {
			throw new Error("The Active Generation has invalid persisted macro writes.");
		}
		const name = generationJsonString(entry.name);
		const operation = generationJsonString(entry.operation);
		if (name === null || !isMacroVariableName(name)) {
			throw new Error("The Active Generation has invalid persisted macro writes.");
		}
		if (operation === "delete") {
			writes.push({ name, operation: "delete", value: undefined });
			continue;
		}
		if (operation !== "set" || !isMacroValue(entry.value)) {
			throw new Error("The Active Generation has invalid persisted macro writes.");
		}
		writes.push({ name, operation: "set", value: entry.value });
	}
	return writes;
};

const parsedInitial = (
	entry: ConversationDataEntry,
	presetId: number,
): { name: string; value: MacroValue } | undefined => {
	const prefix = initialPrefix(presetId);
	if (entry.namespace !== MACRO_DATA_NAMESPACE || !entry.key.startsWith(prefix)) return undefined;
	let name: string;
	try {
		name = decodeURIComponent(entry.key.slice(prefix.length));
	} catch {
		return undefined;
	}
	if (!isMacroVariableName(name)) return undefined;
	const value = parseGenerationJson(entry.value, null);
	return isMacroValue(value) ? { name, value } : undefined;
};

/** ==[HUMAN APPROVED]== Convert one expansion journal into durable Variant records. */
export const macroWritesToData = (
	presetId: number,
	writes: readonly MacroVariableWrite[],
	sequenceStart = 0,
): ConversationDataEntry[] => writes.map((write, index) => ({
	namespace: MACRO_DATA_NAMESPACE,
	key: writeKey(presetId, sequenceStart + index),
	value: writeValue(write),
}));

/** ==[HUMAN APPROVED]== Convert initial preset-scoped values into Conversation records. */
export const macroInitialValuesToData = (
	presetId: number,
	values: ReadonlyMap<string, MacroValue> | Readonly<Record<string, MacroValue>>,
): ConversationDataEntry[] => {
	const entries = values instanceof Map ? [...values.entries()] : Object.entries(values);
	return entries.map(([name, value]) => ({
		namespace: MACRO_DATA_NAMESPACE,
		key: `${initialPrefix(presetId)}${encodedName(name)}`,
		value: JSON.stringify(value),
	}));
};

/** ==[HUMAN APPROVED]== Read only valid initial values for one Conversation and preset. */
export const readMacroInitialValues = (
	entries: readonly ConversationDataEntry[],
	presetId: number,
): Map<string, MacroValue> => {
	const values = new Map<string, MacroValue>();
	for (const entry of entries) {
		const parsed = parsedInitial(entry, presetId);
		if (parsed !== undefined) values.set(parsed.name, parsed.value);
	}
	return values;
};

/** ==[HUMAN APPROVED]== Read ordered resolved writes stored on one Variant for one originating preset. */
export const readMacroWrites = (
	entries: readonly ConversationDataEntry[],
	presetId: number,
): MacroVariableWrite[] => entries
	.map((entry) => ({ entry, write: parsedWrite(entry, presetId) }))
	.filter((item): item is { entry: ConversationDataEntry; write: MacroVariableWrite } => item.write !== undefined)
	.sort((left, right) => left.entry.key.localeCompare(right.entry.key))
	.map(({ write }) => write);

/** ==[HUMAN APPROVED]== Derive effective state from the baseline and selected narrative path, in Message order. */
export const deriveMacroState = (input: {
	initialData: readonly ConversationDataEntry[];
	presetId: number;
	selectedVariants: readonly Pick<ConversationVariantSnapshot, "selected" | "data">[];
}): Map<string, MacroValue> => {
	const state = readMacroInitialValues(input.initialData, input.presetId);
	for (const variant of input.selectedVariants) {
		if (!variant.selected) continue;
		for (const write of readMacroWrites(variant.data, input.presetId)) {
			if (write.operation === "delete") state.delete(write.name);
			else state.set(write.name, write.value ?? null);
		}
	}
	return state;
};

export type MacroVariableSource = SharedMacroVariableSource;
export type DerivedMacroVariable = SharedMacroVariable;

/** ==[HUMAN APPROVED]== Derive effective values while retaining the write that supplied each value. */
export const deriveMacroVariables = (input: {
	initialData: readonly ConversationDataEntry[];
	presetId: number;
	selectedVariants: readonly {
		selected: boolean;
		data: readonly ConversationDataEntry[];
		messageId: number;
		messagePosition: number;
		variantId: number;
		variantPosition: number;
	}[];
}): DerivedMacroVariable[] => {
	const values = new Map<string, DerivedMacroVariable>();
	for (const [name, value] of readMacroInitialValues(input.initialData, input.presetId)) {
		values.set(name, { name, value, source: { type: "initial" } });
	}
	for (const variant of input.selectedVariants) {
		if (!variant.selected) continue;
		for (const write of readMacroWrites(variant.data, input.presetId)) {
			if (write.operation === "delete") {
				values.delete(write.name);
				continue;
			}
			values.set(write.name, {
				name: write.name,
				value: write.value === undefined ? null : write.value,
				source: {
					type: "variant",
					messageId: variant.messageId,
					messagePosition: variant.messagePosition,
					variantId: variant.variantId,
					variantPosition: variant.variantPosition,
				},
			});
		}
	}
	return [...values.values()].sort((left, right) => left.name.localeCompare(right.name));
};

/** ==[HUMAN APPROVED]== Number the next write after existing records on a Variant. */
export const nextMacroWriteSequence = (
	entries: readonly ConversationDataEntry[],
	presetId: number,
): number => readMacroWrites(entries, presetId).length;

export const isMacroDataNamespace = (namespace: string): boolean => namespace === MACRO_DATA_NAMESPACE;
