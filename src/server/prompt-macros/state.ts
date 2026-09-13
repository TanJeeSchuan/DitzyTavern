import {
	decodeMacroVariableWrite,
	encodeMacroVariableWrite,
	isMacroValue,
	isMacroVariableName,
	type MacroValue,
	type MacroVariableWrite,
} from "../../shared/contract/macro-variable-write";
import type { ConversationDataEntry } from "../conversation/types";
import type {
	MacroVariable,
	MacroVariableSource,
} from "../../shared/contract/macro-variables";
import { parseGenerationJson } from "../../shared/generation-provenance";

// ==[HUMAN APPROVED]== Macro records have a domain-owned namespace. Generic data commands must
// not be able to manufacture or overwrite a write because state is derived from
// selected Variants rather than from one mutable Conversation map.
export const MACRO_DATA_NAMESPACE = "prompt-macro";

const writePrefix = (presetId: number): string => `write:${presetId}`;
const encodedName = (name: string): string => encodeURIComponent(name);

export const macroInitialValuePrefix = (presetId: number): string => `initial:${presetId}:`;

export const macroInitialValueKey = (presetId: number, name: string): string =>
	`${macroInitialValuePrefix(presetId)}${encodedName(name)}`;

export const macroWritesKey = (presetId: number): string => writePrefix(presetId);

const parsedWrites = (
	entry: ConversationDataEntry,
	presetId: number,
): MacroVariableWrite[] | undefined => {
	if (entry.namespace !== MACRO_DATA_NAMESPACE || entry.key !== macroWritesKey(presetId)) return undefined;
	const parsed = parseGenerationJson(entry.value, null);
	if (!Array.isArray(parsed)) return undefined;
	const writes: MacroVariableWrite[] = [];
	for (const candidate of parsed) {
		const write = decodeMacroVariableWrite(candidate);
		if (write === undefined) return undefined;
		writes.push(write);
	}
	return writes;
};

/** ==[HUMAN APPROVED]== Decode the crash-safe pending journal persisted on an Active Generation. */
export const parseMacroWrites = (value: string): MacroVariableWrite[] => {
	const parsed = parseGenerationJson(value, null);
	if (!Array.isArray(parsed)) throw new Error("The Active Generation has invalid persisted macro writes.");
	const writes: MacroVariableWrite[] = [];
	for (const candidate of parsed) {
		const write = decodeMacroVariableWrite(candidate);
		if (write === undefined) {
			throw new Error("The Active Generation has invalid persisted macro writes.");
		}
		writes.push(write);
	}
	return writes;
};

const parsedInitial = (
	entry: ConversationDataEntry,
	presetId: number,
): { name: string; value: MacroValue } | undefined => {
	const prefix = macroInitialValuePrefix(presetId);
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
): ConversationDataEntry[] => {
	if (writes.length === 0) return [];
	// ==[HUMAN APPROVED]== The evaluator keeps every write in order so later macros observe earlier
	// values. Durable Variant state only needs the final write for each name;
	// retaining the tombstone is essential because it masks inherited state.
	const finalWrites = new Map<string, MacroVariableWrite>();
	for (const write of writes) finalWrites.set(write.name, write);
	return [{
		namespace: MACRO_DATA_NAMESPACE,
		key: macroWritesKey(presetId),
		value: JSON.stringify([...finalWrites.values()].map(encodeMacroVariableWrite)),
	}];
};

/** ==[HUMAN APPROVED]== Convert initial preset-scoped values into Conversation records. */
export const macroInitialValuesToData = (
	presetId: number,
	values: ReadonlyMap<string, MacroValue> | Readonly<Record<string, MacroValue>>,
): ConversationDataEntry[] => {
	const entries = values instanceof Map ? [...values.entries()] : Object.entries(values);
	return entries.map(([name, value]) => ({
		namespace: MACRO_DATA_NAMESPACE,
		key: macroInitialValueKey(presetId, name),
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
): MacroVariableWrite[] => {
	const entry = entries.find((candidate) => candidate.namespace === MACRO_DATA_NAMESPACE && candidate.key === macroWritesKey(presetId));
	return entry === undefined ? [] : parsedWrites(entry, presetId) ?? [];
};

type SelectedVariant = {
	selected: boolean;
	data: readonly ConversationDataEntry[];
};

const forEachSelectedWrite = <Variant extends SelectedVariant>(
	variants: readonly Variant[],
	presetId: number,
	visit: (write: MacroVariableWrite, variant: Variant) => void,
): void => {
	for (const variant of variants) {
		if (!variant.selected) continue;
		for (const write of readMacroWrites(variant.data, presetId)) visit(write, variant);
	}
};

type FoldedMacroVariable = {
	value: MacroValue;
	source: MacroVariableSource | null;
};

const compareVariableNames = (left: string, right: string): number =>
	left < right ? -1 : left > right ? 1 : 0;

const foldMacroVariables = <Variant extends SelectedVariant>(
	input: {
		initialData: readonly ConversationDataEntry[];
		presetId: number;
		selectedVariants: readonly Variant[];
	},
	initialSource: MacroVariableSource | null,
	variantSource: (variant: Variant) => MacroVariableSource | null,
): Map<string, FoldedMacroVariable> => {
	const values = new Map<string, FoldedMacroVariable>();
	for (const [name, value] of readMacroInitialValues(input.initialData, input.presetId)) {
		values.set(name, { value, source: initialSource });
	}
	forEachSelectedWrite(input.selectedVariants, input.presetId, (write, variant) => {
		if (write.operation === "delete") {
			values.delete(write.name);
			return;
		}
		values.set(write.name, {
			value: write.value,
			source: variantSource(variant),
		});
	});
	return values;
};

/** ==[HUMAN APPROVED]== Derive effective state from the baseline and selected narrative path, in Message order. */
export const deriveMacroState = (input: {
	initialData: readonly ConversationDataEntry[];
	presetId: number;
	selectedVariants: readonly SelectedVariant[];
}): Map<string, MacroValue> => new Map(
	[...foldMacroVariables(input, null, () => null)].map(([name, value]) => [name, value.value]),
);

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
}): MacroVariable[] => {
	const values = foldMacroVariables(
		input,
		{ type: "initial" },
		(variant) => ({
			type: "variant",
			messageId: variant.messageId,
			messagePosition: variant.messagePosition,
			variantId: variant.variantId,
			variantPosition: variant.variantPosition,
		}),
	);
	return [...values.entries()]
		.sort(([left], [right]) => compareVariableNames(left, right))
		.map(([name, value]) => ({
			name,
			value: value.value,
			source: value.source!,
		}));
};

export const isMacroDataNamespace = (namespace: string): boolean => namespace === MACRO_DATA_NAMESPACE;
