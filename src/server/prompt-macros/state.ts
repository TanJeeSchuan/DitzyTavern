import { variantDataCodecs, MACRO_DATA_NAMESPACE, macroWritesKey } from "../../shared/variant-data-codecs";
import {
	isMacroValue,
	isMacroVariableName,
	type MacroValue,
	type MacroVariableWrite,
} from "../../shared/contract/macro-variable-write";
import type { ConversationDataEntry } from "../conversation";
import type {
	MacroVariable,
	MacroVariableSource,
} from "../../shared/contract/macro-variables";
import { parseGenerationJson } from "../../shared/generation-provenance";

// @approved
//  Macro records have a domain-owned namespace. Generic data commands must
// not be able to manufacture or overwrite a write because state is derived from
// selected Variants rather than from one mutable Conversation map.

const encodedName = (name: string): string => encodeURIComponent(name);

export const macroInitialValuePrefix = (presetId: number): string => `initial:${presetId}:`;

export const macroInitialValueKey = (presetId: number, name: string): string =>
	`${macroInitialValuePrefix(presetId)}${encodedName(name)}`;

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

/** @approved Convert one expansion journal into durable Variant records. */
export const macroWritesToData = (
	presetId: number,
	writes: readonly MacroVariableWrite[],
): ConversationDataEntry[] => {
	if (writes.length === 0) return [];
	return [{ namespace: MACRO_DATA_NAMESPACE, key: macroWritesKey(presetId), value: variantDataCodecs.macroWrites.encode(writes) }];
};

/** @approved Convert initial preset-scoped values into Conversation records. */
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

/** @approved Read only valid initial values for one Conversation and preset. */
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

type MacroWriteRecord = { key: string; writes: MacroVariableWrite[] };

/** @approved Read ordered resolved writes stored on one Variant for one originating preset. */
export const readMacroWrites = (
	records: readonly MacroWriteRecord[],
	presetId: number,
): MacroVariableWrite[] => records.find((record) => record.key === macroWritesKey(presetId))?.writes ?? [];

type SelectedVariant = {
	selected: boolean;
	macroWrites: readonly MacroWriteRecord[];
};

const forEachSelectedWrite = <Variant extends SelectedVariant>(
	variants: readonly Variant[],
	presetId: number,
	visit: (write: MacroVariableWrite, variant: Variant) => void,
): void => {
	for (const variant of variants) {
		if (!variant.selected) continue;
		for (const write of readMacroWrites(variant.macroWrites, presetId)) visit(write, variant);
	}
};

const compareVariableNames = (left: string, right: string): number =>
	left < right ? -1 : left > right ? 1 : 0;

/** @approved Derive effective state from the baseline and selected narrative path, in Message order. */
export const deriveMacroState = (input: {
	initialData: readonly ConversationDataEntry[];
	presetId: number;
	selectedVariants: readonly SelectedVariant[];
}): Map<string, MacroValue> => {
	const values = readMacroInitialValues(input.initialData, input.presetId);
	forEachSelectedWrite(input.selectedVariants, input.presetId, (write) => {
		if (write.operation === "delete") values.delete(write.name);
		else values.set(write.name, write.value);
	});
	return values;
};

/** @approved Derive effective values while retaining the write that supplied each value. */
export const deriveMacroVariables = (input: {
	initialData: readonly ConversationDataEntry[];
	presetId: number;
	selectedVariants: readonly {
		selected: boolean;
		macroWrites: readonly MacroWriteRecord[];
		messageId: number;
		messagePosition: number;
		variantId: number;
		variantPosition: number;
	}[];
}): MacroVariable[] => {
	const values = new Map<string, { value: MacroValue; source: MacroVariableSource }>();
	for (const [name, value] of readMacroInitialValues(input.initialData, input.presetId)) {
		values.set(name, { value, source: { type: "initial" } });
	}
	forEachSelectedWrite(input.selectedVariants, input.presetId, (write, variant) => {
		if (write.operation === "delete") {
			values.delete(write.name);
			return;
		}
		values.set(write.name, {
			value: write.value,
			source: {
			type: "variant",
			messageId: variant.messageId,
			messagePosition: variant.messagePosition,
			variantId: variant.variantId,
			variantPosition: variant.variantPosition,
			},
		});
	});
	return [...values.entries()]
		.sort(([left], [right]) => compareVariableNames(left, right))
		.map(([name, value]) => ({
			name,
			value: value.value,
			source: value.source,
		}));
};

export const isMacroDataNamespace = (namespace: string): boolean => namespace === MACRO_DATA_NAMESPACE;
