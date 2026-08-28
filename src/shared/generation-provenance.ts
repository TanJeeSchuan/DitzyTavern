// The generation-owned JSON vocabulary shared by persistence and transport.
// Generation provenance is deliberately a small positive allow-list: it may
// carry safe identity, settings, usage, and terminal outcome metadata, but
// never provider payloads, URLs, headers, credentials, or request overrides.

export type GenerationJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly GenerationJsonValue[]
	| Readonly<{ [key: string]: GenerationJsonValue }>;

export type GenerationJsonObject = Readonly<{ [key: string]: GenerationJsonValue }>;

export type GenerationProvenanceStatus = "complete" | "length-limited" | "interrupted";
export type GenerationProvenanceFinishReason = "stop" | "length" | "other";
export type GenerationContinuationStrategy = "instruction" | "assistant-prefill";
export type GenerationContinuationPrefillSuffix = "" | " " | "\n" | "\n\n";

export interface GenerationProvenanceSettings {
	temperature: number | null;
	topP: number | null;
	frequencyPenalty: number | null;
	presencePenalty: number | null;
	contextLimit: number | null;
	responseBudget: number | null;
	safetyAllowance: number | null;
	siblingGenerationLimit: number | null;
	continuationStrategy: GenerationContinuationStrategy | null;
	continuationInstruction: string | null;
	continuationPrefillSuffix: GenerationContinuationPrefillSuffix | null;
}

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

// A start-time provenance record has no terminal status yet. The same record
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

const emptyGenerationSettings = (): GenerationProvenanceSettings => ({
	temperature: null,
	topP: null,
	frequencyPenalty: null,
	presencePenalty: null,
	contextLimit: null,
	responseBudget: null,
	safetyAllowance: null,
	siblingGenerationLimit: null,
	continuationStrategy: null,
	continuationInstruction: null,
	continuationPrefillSuffix: null,
});

export const generationJsonObject = (
	value: GenerationJsonValue | undefined,
): GenerationJsonObject | null => {
	if (Object.prototype.toString.call(value) !== "[object Object]") return null;
	// SAFETY: the object tag check establishes the JSON object shape before the
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
		// SAFETY: JSON.parse is the only boundary from persisted text into the
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

const provenanceSettings = (
	value: GenerationJsonValue | undefined,
): GenerationProvenanceSettings => {
	const source = generationJsonObject(value);
	if (source === null) return emptyGenerationSettings();
	const strategy = provenanceString(source.continuationStrategy);
	const suffix = provenanceString(source.continuationPrefillSuffix);
	return {
		temperature: provenanceNumber(source.temperature),
		topP: provenanceNumber(source.topP),
		frequencyPenalty: provenanceNumber(source.frequencyPenalty),
		presencePenalty: provenanceNumber(source.presencePenalty),
		contextLimit: generationJsonInteger(source.contextLimit),
		responseBudget: generationJsonInteger(source.responseBudget),
		safetyAllowance: generationJsonInteger(source.safetyAllowance),
		siblingGenerationLimit: generationJsonInteger(source.siblingGenerationLimit),
		continuationStrategy: strategy === "instruction" || strategy === "assistant-prefill"
			? strategy
			: null,
		continuationInstruction: provenanceString(source.continuationInstruction),
		continuationPrefillSuffix: suffix === "" || suffix === " " || suffix === "\n" || suffix === "\n\n"
			? suffix
			: null,
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
	const legacyFinish = generationJsonObject(source.finish);
	return {
		connectionProfileId: generationJsonNumber(source.connectionProfileId),
		connectionSettingsRevision: generationJsonNumber(source.connectionSettingsRevision),
		modelBackend: provenanceString(source.modelBackend),
		adapter: provenanceString(source.adapter),
		modelId: provenanceString(source.modelId),
		generationSettings: provenanceSettings(source.generationSettings),
		usage: generationUsage(source.usage),
		finishReason: provenanceFinishReason(source.finishReason) ?? provenanceFinishReason(legacyFinish?.reason),
		status: provenanceStatus(source.status),
		interruptionCause: provenanceString(source.interruptionCause),
	};
};

// Strict transport decoder for terminal Variant details. Start-time records
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

// Named as a codec so persistence and transport call the same boundary
// explicitly instead of each growing another local provenance parser.
export const generationProvenanceCodec = {
	decode: decodeGenerationProvenance,
	decodeRecord: decodeGenerationProvenanceRecord,
	decodeStored: decodeStoredGenerationProvenance,
	encode: encodeGenerationProvenance,
	project: projectGenerationProvenance,
	readTerminalMetadata: readGenerationTerminalMetadata,
} as const;
