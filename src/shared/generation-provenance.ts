// ==[HUMAN APPROVED]== The generation-owned JSON vocabulary shared by persistence and transport.
// Generation provenance is deliberately a small positive allow-list: it may
// carry safe identity, settings, usage, and terminal outcome metadata, but
// never provider payloads, URLs, headers, credentials, or request overrides.

import type { GenerationJsonObject, GenerationJsonValue } from "./generation-json";
import {
	GENERATION_SETTINGS_FIELDS,
	type CanonicalGenerationSettings,
	type GenerationSettingsField,
} from "./contract/generation-settings";

// ==[HUMAN APPROVED]== The generation-owned JSON vocabulary is declared in the shared leaf module
// so the Generation Settings contract and this module can both import it
// without an import cycle; it stays part of this module's public vocabulary.
export type { GenerationJsonObject, GenerationJsonValue };

export type GenerationProvenanceStatus = "complete" | "length-limited" | "interrupted";
export type GenerationProvenanceFinishReason = "stop" | "length" | "other";

// ==[HUMAN APPROVED]== The retained provenance settings derive from the canonical Generation
// Settings declaration (ADR-0032): every canonical field except model
// identity (captured beside the connection identity at provenance top
// level) and Request Overrides (never retained — provenance is a positive
// allow-list) participates, and every participating field is explicitly
// nullable. A value DitzyTavern did not configure decodes as null, never as
// an accidental zero or empty string.
export type ProvenanceSettingsField = Exclude<
	GenerationSettingsField,
	"modelId" | "requestOverrides"
>;

export type GenerationProvenanceSettings = {
	[K in ProvenanceSettingsField]: CanonicalGenerationSettings[K] | null;
};

export type GenerationContinuationStrategy = NonNullable<
	GenerationProvenanceSettings["continuationStrategy"]
>;
export type GenerationContinuationPrefillSuffix = NonNullable<
	GenerationProvenanceSettings["continuationPrefillSuffix"]
>;

// ==[HUMAN APPROVED]== The canonical field vocabulary retained in provenance is projected from
// the canonical Generation Settings declaration. Keeping the runtime list
// derived means adding or removing a canonical field updates this vocabulary
// automatically; the typed decoders and wire schemas below still require an
// explicit per-field decision for every retained field.
export const PROVENANCE_SETTINGS_FIELDS = GENERATION_SETTINGS_FIELDS.filter(
	(field): field is ProvenanceSettingsField =>
		field !== "modelId" && field !== "requestOverrides",
);

export type GenerationUsage = Record<string, number>;

interface GenerationProvenanceFields {
	connectionProfileId: number | null;
	connectionSettingsRevision: number | null;
	modelBackend: string | null;
	adapter: string | null;
	modelId: string | null;
	generationSettings: GenerationProvenanceSettings;
	usage: GenerationUsage | null;
	finishReason: GenerationProvenanceFinishReason | null;
	interruptionCause: string | null;
}

// ==[HUMAN APPROVED]== A start-time provenance record has no terminal status yet. The same record
// is used by persistence and transport so the two cannot drift in field
// names, nullability, or allow-list behavior.
export type GenerationProvenanceRecord = GenerationProvenanceFields & {
	status: GenerationProvenanceStatus | null;
};

export type GenerationProvenance = GenerationProvenanceFields & {
	status: GenerationProvenanceStatus;
};

export interface GenerationProvenanceDataEntry {
	namespace: string;
	key: string;
	value: string;
}

export interface GenerationTerminalMetadata {
	status?: GenerationProvenanceStatus | undefined;
	usage?: GenerationUsage | null | undefined;
	finishReason?: GenerationProvenanceFinishReason | null | undefined;
	interruptionCause?: string | null | undefined;
}

const emptyGenerationSettings = (): GenerationProvenanceSettings => provenanceSettings(undefined);

export const generationJsonObject = (
	value: GenerationJsonValue | undefined,
): GenerationJsonObject | null => {
	if (Object.prototype.toString.call(value) !== "[object Object]") return null;
	// ==[HUMAN APPROVED]== SAFETY: the object tag check establishes the JSON object shape before the
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

export const generationJsonBoolean = (value: GenerationJsonValue | undefined): boolean | null =>
	Object.prototype.toString.call(value) === "[object Boolean]" ? Boolean(value) : null;

export const generationJsonNullableNumber = (
	value: GenerationJsonValue | undefined,
): number | null => value === null ? null : generationJsonNumber(value);

export const parseGenerationJson = (
	value: string,
	fallback: GenerationJsonValue,
): GenerationJsonValue => {
	try {
		// ==[HUMAN APPROVED]== SAFETY: JSON.parse is the only boundary from persisted text into the
		// closed Generation JSON value type; malformed text uses the fallback.
		return JSON.parse(value) as GenerationJsonValue;
	} catch {
		return fallback;
	}
};

const provenanceNumber = (value: GenerationJsonValue | undefined): number | null =>
	generationJsonNumber(value);

const provenanceString = (value: GenerationJsonValue | undefined): string | null =>
	generationJsonString(value);

const provenanceStatus = (value: GenerationJsonValue | undefined): GenerationProvenanceStatus | null =>
	value === "complete" || value === "length-limited" || value === "interrupted"
		? value
		: null;

const provenanceFinishReason = (
	value: GenerationJsonValue | undefined,
): GenerationProvenanceFinishReason | null =>
	value === "stop" || value === "length" || value === "other" ? value : null;

// ==[HUMAN APPROVED]== Closed-literal decoding for the Continuation vocabulary: anything else —
// including an absent value — decodes as null rather than being guessed.
const closedProvenanceLiteral = <T extends string>(
	value: GenerationJsonValue | undefined,
	literals: readonly T[],
): T | null => {
	const text = provenanceString(value);
	// ==[HUMAN APPROVED]== SAFETY: membership in the closed literal list is checked before the
	// string is returned as one of those literals.
	return text !== null && (literals as readonly string[]).includes(text)
		? (text as T)
		: null;
};

// ==[HUMAN APPROVED]== The provenance value for each retained settings field, decoded from
// untrusted JSON. Compile-locked: adding a retained canonical field fails
// typecheck until the decode states its nullability semantics.
type ProvenanceSettingsDecoder = {
	readonly [K in ProvenanceSettingsField]: (
		source: GenerationJsonObject,
	) => GenerationProvenanceSettings[K];
};

const decodeProvenanceSettingsField: ProvenanceSettingsDecoder = {
	temperature: (source) => provenanceNumber(source.temperature),
	topP: (source) => provenanceNumber(source.topP),
	frequencyPenalty: (source) => provenanceNumber(source.frequencyPenalty),
	presencePenalty: (source) => provenanceNumber(source.presencePenalty),
	contextLimit: (source) => generationJsonInteger(source.contextLimit),
	responseBudget: (source) => generationJsonInteger(source.responseBudget),
	safetyAllowance: (source) => generationJsonInteger(source.safetyAllowance),
	siblingGenerationLimit: (source) => generationJsonInteger(source.siblingGenerationLimit),
	continuationStrategy: (source) =>
		closedProvenanceLiteral(source.continuationStrategy, [
			"instruction",
			"assistant-prefill",
		] as const),
	continuationInstruction: (source) => provenanceString(source.continuationInstruction),
	continuationPrefillSuffix: (source) =>
		closedProvenanceLiteral(source.continuationPrefillSuffix, ["", " ", "\n", "\n\n"] as const),
};

const provenanceSettings = (
	value: GenerationJsonValue | undefined,
): GenerationProvenanceSettings => {
	// ==[HUMAN APPROVED]== SAFETY: a non-object source decodes as an empty record, and every field
	// decoder then resolves its own intentional null.
	const source = generationJsonObject(value) ?? {};
	return {
		temperature: decodeProvenanceSettingsField.temperature(source),
		topP: decodeProvenanceSettingsField.topP(source),
		frequencyPenalty: decodeProvenanceSettingsField.frequencyPenalty(source),
		presencePenalty: decodeProvenanceSettingsField.presencePenalty(source),
		contextLimit: decodeProvenanceSettingsField.contextLimit(source),
		responseBudget: decodeProvenanceSettingsField.responseBudget(source),
		safetyAllowance: decodeProvenanceSettingsField.safetyAllowance(source),
		siblingGenerationLimit: decodeProvenanceSettingsField.siblingGenerationLimit(source),
		continuationStrategy: decodeProvenanceSettingsField.continuationStrategy(source),
		continuationInstruction: decodeProvenanceSettingsField.continuationInstruction(source),
		continuationPrefillSuffix: decodeProvenanceSettingsField.continuationPrefillSuffix(source),
	};
};

const generationUsage = (value: GenerationJsonValue | undefined): GenerationUsage | null => {
	if (value === null || value === undefined) return null;
	const source = generationJsonObject(value);
	if (source === null) return null;
	const usage: GenerationUsage = {};
	for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
		const number = generationJsonNumber(source[key]);
		if (number !== null && number >= 0) usage[key] = number;
	}
	return Object.keys(usage).length === 0 ? null : usage;
};

const emptyGenerationProvenance = (): GenerationProvenanceRecord => ({
	connectionProfileId: null,
	connectionSettingsRevision: null,
	modelBackend: null,
	adapter: null,
	modelId: null,
	generationSettings: emptyGenerationSettings(),
	usage: null,
	finishReason: null,
	status: null,
	interruptionCause: null,
});

export const decodeGenerationProvenanceRecord = (
	value: GenerationJsonValue | null | undefined,
): GenerationProvenanceRecord | null | undefined => {
	if (value === null) return null;
	const source = generationJsonObject(value);
	if (source === null) return undefined;
	return {
		connectionProfileId: generationJsonNumber(source.connectionProfileId),
		connectionSettingsRevision: generationJsonNumber(source.connectionSettingsRevision),
		modelBackend: provenanceString(source.modelBackend),
		adapter: provenanceString(source.adapter),
		modelId: provenanceString(source.modelId),
		generationSettings: provenanceSettings(source.generationSettings),
		usage: generationUsage(source.usage),
		finishReason: provenanceFinishReason(source.finishReason),
		status: provenanceStatus(source.status),
		interruptionCause: provenanceString(source.interruptionCause),
	};
};

// ==[HUMAN APPROVED]== Strict transport decoder for terminal Variant details. Start-time records
// intentionally permit a null status, but a terminal response must identify
// its status and carry a generationSettings object.
export const decodeGenerationProvenance = (
	value: GenerationJsonValue | null | undefined,
): GenerationProvenance | null | undefined => {
	if (value === null) return null;
	const source = generationJsonObject(value);
	if (source === null || generationJsonObject(source.generationSettings) === null) return undefined;
	const status = provenanceStatus(source.status);
	if (status === null) return undefined;
	const record = decodeGenerationProvenanceRecord(value);
	return record === null || record === undefined ? undefined : { ...record, status };
};

export const encodeGenerationProvenance = (value: GenerationProvenanceRecord | GenerationProvenance): string =>
	JSON.stringify(value);

export const readGenerationTerminalMetadata = (
	data: readonly GenerationProvenanceDataEntry[],
): GenerationTerminalMetadata => {
	const outcome = data.find((entry) => entry.namespace === "generation" && entry.key === "outcome")?.value;
	const usageEntry = data.find((entry) => entry.namespace === "generation" && entry.key === "usage");
	const finishEntry = data.find((entry) => entry.namespace === "generation" && entry.key === "finish");
	const interruptionEntry = data.find((entry) => entry.namespace === "generation" && entry.key === "interruption-cause");
	const usage = usageEntry === undefined
		? undefined
		: generationUsage(parseGenerationJson(usageEntry.value, null));
	const finish = finishEntry === undefined
		? undefined
		: generationJsonObject(parseGenerationJson(finishEntry.value, null));
	return {
		status: outcome === "complete" || outcome === "length-limited" || outcome === "interrupted"
			? outcome
			: undefined,
		usage,
		finishReason: finish === null || finish === undefined
			? undefined
			: provenanceFinishReason(finish.reason) ?? undefined,
		interruptionCause: interruptionEntry?.value,
	};
};

export const hasGenerationTerminalMetadata = (
	data: readonly GenerationProvenanceDataEntry[],
): boolean => data.some((entry) =>
		entry.namespace === "generation" &&
		(entry.key === "outcome" || entry.key === "usage" || entry.key === "finish"),
);

export const projectGenerationProvenance = (
	value: GenerationJsonValue | null | undefined,
	terminal: GenerationTerminalMetadata,
): GenerationProvenance => {
	const decoded = decodeGenerationProvenanceRecord(value);
	const source = decoded === null || decoded === undefined ? emptyGenerationProvenance() : decoded;
	return {
		...source,
		usage: terminal.usage === undefined ? source.usage : terminal.usage,
		finishReason: terminal.finishReason === undefined ? source.finishReason : terminal.finishReason,
		status: terminal.status ?? source.status ?? "complete",
		interruptionCause: terminal.interruptionCause === undefined
			? source.interruptionCause
			: terminal.interruptionCause,
	};
};

export const decodeStoredGenerationProvenance = (
	value: GenerationJsonValue | null | undefined,
	data: readonly GenerationProvenanceDataEntry[],
): GenerationProvenance | null => {
	const source = value === null || value === undefined ? null : generationJsonObject(value);
	if (source === null && !hasGenerationTerminalMetadata(data)) return null;
	return projectGenerationProvenance(source, readGenerationTerminalMetadata(data));
};

// ==[HUMAN APPROVED]== Named as a codec so persistence and transport call the same boundary
// explicitly instead of each growing another local provenance parser.
export const generationProvenanceCodec = {
	decode: decodeGenerationProvenance,
	decodeRecord: decodeGenerationProvenanceRecord,
	decodeStored: decodeStoredGenerationProvenance,
	encode: encodeGenerationProvenance,
	project: projectGenerationProvenance,
	readTerminalMetadata: readGenerationTerminalMetadata,
} as const;
