import { Value } from "@sinclair/typebox/value";
import type { Static, TSchema } from "@sinclair/typebox";
import { GENERATION_DATA_NAMESPACE, GENERATION_DATA_KEYS } from "./variant-data-codecs";
import type { GenerationJsonObject, GenerationJsonValue } from "./generation-json";
import { generationUsage } from "./contract/generation-events";
import {
	generationFinish,
	generationProvenance,
	generationProvenanceRecord,
	generationProvenanceStatus,
	type GenerationProvenance,
	type GenerationProvenanceRecord,
} from "./contract/generation-provenance";

// @approved
//  The generation-owned JSON vocabulary is declared in the shared leaf module
// so the Generation Settings contract and this module can both import it
// without an import cycle; it stays part of this module's public vocabulary.
export type { GenerationJsonObject, GenerationJsonValue };

export interface GenerationProvenanceDataEntry {
	namespace: string;
	key: string;
	value: string;
}

export const generationJsonObject = (
	value: GenerationJsonValue | undefined,
): GenerationJsonObject | null => {
	if (Object.prototype.toString.call(value) !== "[object Object]") return null;
	// @approved
	//  SAFETY: the object tag check establishes the JSON object shape before the
	// value is used as a named-field map.
	return value as GenerationJsonObject;
};

export const generationJsonNumber = (value: GenerationJsonValue | undefined): number | null => {
	if (Object.prototype.toString.call(value) !== "[object Number]") return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
};

export const generationJsonInteger = (value: GenerationJsonValue | undefined): number | null => {
	const number = generationJsonNumber(value);
	return number !== null && Number.isInteger(number) ? number : null;
};

export const generationJsonString = (value: GenerationJsonValue | undefined): string | null =>
	Object.prototype.toString.call(value) === "[object String]" ? String(value) : null;

export const parseGenerationJson = (
	value: string,
	fallback: GenerationJsonValue,
): GenerationJsonValue => {
	try {
		// @approved
		//  SAFETY: JSON.parse is the only boundary from persisted text into the
		// closed Generation JSON value type; malformed text uses the fallback.
		return JSON.parse(value) as GenerationJsonValue;
	} catch {
		return fallback;
	}
};

const decodeStored = <T extends TSchema>(schema: T, value: string, what: string, place: string): Static<T> => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch (cause) {
		throw new Error(`Persisted ${what} at ${place} is malformed JSON.`, { cause });
	}
	// @approved
	// Provenance is a positive allow-list: a property outside the schema is
	// dropped rather than retained or displayed.
	const cleaned = Value.Clean(schema, parsed);
	if (!Value.Check(schema, cleaned)) throw new Error(`Persisted ${what} at ${place} does not match its schema.`);
	return cleaned;
};

// @approved
// The terminal outcome entries written beside a durable Variant. An absent
// outcome means the Generation completed; the others are absent when the
// attempt reported nothing.
const terminalMetadata = (data: readonly GenerationProvenanceDataEntry[], place: string) => {
	const entry = (key: string) => data.find((item) => item.namespace === GENERATION_DATA_NAMESPACE && item.key === key)?.value;
	const outcome = entry(GENERATION_DATA_KEYS.outcome);
	const usage = entry(GENERATION_DATA_KEYS.usage);
	const finish = entry(GENERATION_DATA_KEYS.finish);
	if (outcome !== undefined && !Value.Check(generationProvenanceStatus, outcome)) {
		throw new Error(`Persisted Generation outcome at ${place} is not a terminal status.`);
	}
	return {
		status: outcome,
		usage: usage === undefined ? undefined : decodeStored(generationUsage, usage, "Generation usage", place),
		finishReason: finish === undefined ? undefined : decodeStored(generationFinish, finish, "Generation finish", place).reason,
		interruptionCause: entry(GENERATION_DATA_KEYS.interruptionCause),
	};
};

const project = (record: GenerationProvenanceRecord, terminal: ReturnType<typeof terminalMetadata>): GenerationProvenance => ({
	...record,
	usage: terminal.usage ?? record.usage,
	finishReason: terminal.finishReason ?? record.finishReason,
	status: terminal.status ?? record.status ?? "complete",
	interruptionCause: terminal.interruptionCause ?? record.interruptionCause,
});

// @approved
//  Named as a codec so persistence and transport call the same boundary
// explicitly instead of each growing another local provenance parser.
// `place` names where the record is stored, so a corrupt one is located.
export const generationProvenanceCodec = {
	encode: (value: GenerationProvenanceRecord): string => JSON.stringify(value),
	// @approved
	// The terminal record written beside the durable Variant: the start-time
	// record with the attempt's terminal outcome applied.
	terminal: (serialized: string, data: readonly GenerationProvenanceDataEntry[], place: string): string => JSON.stringify(project(
		decodeStored(generationProvenanceRecord, serialized, "Generation provenance", place),
		terminalMetadata(data, place),
	)),
	// @approved
	// A Variant's displayed provenance: its terminal record, or the
	// all-unavailable record under terminal metadata written without one.
	read: (data: readonly GenerationProvenanceDataEntry[], place: string): GenerationProvenance | null => {
		const record = data.find((entry) => entry.namespace === GENERATION_DATA_NAMESPACE && entry.key === GENERATION_DATA_KEYS.provenance);
		if (record !== undefined) return decodeStored(generationProvenance, record.value, "Generation provenance", place);
		const terminal = terminalMetadata(data, place);
		if (terminal.status === undefined && terminal.usage === undefined && terminal.finishReason === undefined) return null;
		return project(Value.Create(generationProvenanceRecord), terminal);
	},
} as const;
