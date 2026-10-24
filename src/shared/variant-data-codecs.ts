import { Value } from "@sinclair/typebox/value";
import {
	generationProvenanceCodec, generationJsonObject, parseGenerationJson,
	type GenerationJsonValue, type GenerationProvenanceDataEntry, type GenerationProvenanceRecord,
} from "./generation-provenance";
import { loreActivationRecord, type LoreActivationRecord } from "./contract/lore-activation";
import { boxTraces, type BoxTraces } from "./contract/box-generation";
import { decodeMacroVariableWrite, encodeMacroVariableWrite, type MacroVariableWrite } from "./contract/macro-variable-write";

export class LoreActivationRecordParseError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };

	constructor(message: string) {
		super(message);
		this.name = "LoreActivationRecordParseError";
	}
}

/** @approved Decode persisted JSON without turning malformed or invalid records into an absent record. */
const parseLoreActivationRecord = (serialized: string): LoreActivationRecord | null => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(serialized);
	} catch {
		throw new LoreActivationRecordParseError("Persisted Lore Activation Record is not valid JSON.");
	}
	if (parsed === null) return null;
	if (!Value.Check(loreActivationRecord, parsed)) {
		throw new LoreActivationRecordParseError("Persisted Lore Activation Record does not match the canonical schema.");
	}
	// @approved
	// SAFETY: Value.Check establishes the complete canonical record shape before this cast.
	return parsed as LoreActivationRecord;
};

export class BoxTracesParseError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };

	constructor(message: string) {
		super(message);
		this.name = "BoxTracesParseError";
	}
}

const parseBoxTraces = (serialized: string): BoxTraces => {
	let parsed: unknown;
	try { parsed = JSON.parse(serialized); } catch { throw new BoxTracesParseError("Persisted Box traces are not valid JSON."); }
	try { return Value.Parse(boxTraces, parsed); } catch { throw new BoxTracesParseError("Persisted Box traces do not match their schema."); }
};

export const GENERATION_DATA_NAMESPACE = "generation";
export const GENERATION_DATA_KEYS = {
	reasoning: "reasoning", provenance: "provenance", intent: "intent",
	outcome: "outcome", usage: "usage", finish: "finish", interruptionCause: "interruption-cause",
} as const;

export const LORE_ACTIVATION_NAMESPACE = "lore-activation";
export const LORE_ACTIVATION_KEY = "record";
export const BOX_TRACES_NAMESPACE = "generation-box";
export const BOX_TRACES_KEY = "traces";
export const MACRO_DATA_NAMESPACE = "prompt-macro";
export const macroWritesKey = (presetId: number): string => `write:${presetId}`;

const invalidMacroWrites = "The Active Generation has invalid persisted macro writes.";
const invalidIntent = "The Active Generation has invalid persisted Generation intent.";

const decodeMacroWrites = (serialized: string): MacroVariableWrite[] | undefined => {
	const parsed = parseGenerationJson(serialized, null);
	if (!Array.isArray(parsed)) return undefined;
	const writes: MacroVariableWrite[] = [];
	for (const candidate of parsed) {
		const write = decodeMacroVariableWrite(candidate);
		if (write === undefined) return undefined;
		writes.push(write);
	}
	return writes;
};

export const variantDataCodecs = {
	reasoning: {
		namespace: GENERATION_DATA_NAMESPACE, key: GENERATION_DATA_KEYS.reasoning,
		keys: [GENERATION_DATA_KEYS.reasoning],
		decode: (serialized: string): string => serialized,
		encode: (value: string): string => value,
	},
	provenance: {
		namespace: GENERATION_DATA_NAMESPACE, key: GENERATION_DATA_KEYS.provenance,
		keys: [GENERATION_DATA_KEYS.provenance, GENERATION_DATA_KEYS.outcome, GENERATION_DATA_KEYS.usage, GENERATION_DATA_KEYS.finish, GENERATION_DATA_KEYS.interruptionCause],
		decode: (serialized: string) => parseGenerationJson(serialized, null),
		read: (entries: readonly GenerationProvenanceDataEntry[]) => generationProvenanceCodec.decodeStored(
			parseGenerationJson(entries.find((entry) => entry.namespace === variantDataCodecs.provenance.namespace && entry.key === variantDataCodecs.provenance.key)?.value ?? "null", null), entries,
		),
		encode: (value: GenerationProvenanceRecord) => generationProvenanceCodec.encode(value),
		terminal: (serialized: string, entries: readonly GenerationProvenanceDataEntry[]) => generationProvenanceCodec.encode(
			generationProvenanceCodec.project(parseGenerationJson(serialized, null), generationProvenanceCodec.readTerminalMetadata(entries)),
		),
	},
	intent: {
		namespace: GENERATION_DATA_NAMESPACE, key: GENERATION_DATA_KEYS.intent, keys: [GENERATION_DATA_KEYS.intent],
		decode: (serialized: string) => parseGenerationJson(serialized, {}),
		parse: (serialized: string) => {
			const parsed = generationJsonObject(parseGenerationJson(serialized, null));
			if (parsed === null || (parsed.type !== "tail" && parsed.type !== "continuation" && parsed.type !== "sibling")) throw new Error(invalidIntent);
			return parsed;
		},
		encode: (value: GenerationJsonValue) => JSON.stringify(value),
		parseError: invalidIntent,
	},
	loreActivation: {
		namespace: LORE_ACTIVATION_NAMESPACE, key: LORE_ACTIVATION_KEY, keys: [LORE_ACTIVATION_KEY],
		decode: parseLoreActivationRecord,
		encode: (value: LoreActivationRecord) => JSON.stringify(value),
	},
	boxTraces: {
		namespace: BOX_TRACES_NAMESPACE, key: BOX_TRACES_KEY, keys: [BOX_TRACES_KEY],
		decode: parseBoxTraces,
		encode: (value: BoxTraces) => JSON.stringify(value),
	},
	macroWrites: {
		namespace: MACRO_DATA_NAMESPACE, key: macroWritesKey, keys: [], keyPrefix: "write:",
		decode: (serialized: string): MacroVariableWrite[] => {
			const writes = decodeMacroWrites(serialized);
			if (writes === undefined) throw new Error(invalidMacroWrites);
			return writes;
		},
		decodeOptional: decodeMacroWrites,
		encode: (writes: readonly MacroVariableWrite[]): string => {
			const final = new Map<string, MacroVariableWrite>();
			for (const write of writes) final.set(write.name, write);
			return JSON.stringify([...final.values()].map(encodeMacroVariableWrite));
		},
		parseError: invalidMacroWrites,
	},
} as const;

export type VariantDataName = keyof typeof variantDataCodecs;

export const toVariantDataEntry = (codec: { namespace: string; key: string }, value: string): GenerationProvenanceDataEntry => ({
	namespace: codec.namespace, key: codec.key, value,
});
