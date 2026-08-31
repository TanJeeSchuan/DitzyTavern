import { Kind, Type, type Static } from "@sinclair/typebox";
import type { GenerationJsonValue } from "../generation-provenance";

// The one canonical runtime declaration of the Generation Settings
// structure (ADR-0032): model selection, sampling parameters, budget
// fields, the Continuation strategy group, and Request Overrides. Every
// compatible schema form derives from this object, and every consuming
// boundary — database storage, update requiredness, provenance, Model
// Client input, active inspection — must prove exhaustive handling of its
// field vocabulary.
//
// Validation mirrors the Conversation module's settings domain: the schema
// accepts every currently valid setting and rejects the invalid model,
// sampling, budget, continuation, and Request Overrides values the domain
// rejects. Normalization such as trimming a model ID stays with the owning
// domain adapter; this declaration is structural, not mutating.

// Provider Request Override values keep the shared Generation JSON
// vocabulary. The runtime schema stays open like every other opaque
// Generation JSON boundary (the same Kind-Unknown technique the transport
// contract uses), while the type stays exact and recursive for Eden.
const generationJsonValue = Type.Unsafe<GenerationJsonValue>({ [Kind]: "Unknown" });
const generationJsonObject = Type.Record(Type.String(), generationJsonValue);

// Sampling values: null means the provider default; otherwise a finite
// value between -2 and 2.
const samplingValue = Type.Union([Type.Null(), Type.Number({ minimum: -2, maximum: 2 })]);

export const canonicalGenerationSettings = Type.Object({
	// A model ID must contain non-whitespace content; surrounding
	// whitespace is accepted and trimmed by the owning domain adapter.
	modelId: Type.String({ pattern: "\\S" }),
	temperature: samplingValue,
	topP: samplingValue,
	frequencyPenalty: samplingValue,
	presencePenalty: samplingValue,
	contextLimit: Type.Integer({ minimum: 1 }),
	responseBudget: Type.Integer({ minimum: 1 }),
	// The Safety allowance is the only budget field that accepts zero.
	safetyAllowance: Type.Integer({ minimum: 0 }),
	siblingGenerationLimit: Type.Integer({ minimum: 1 }),
	continuationStrategy: Type.Union([
		Type.Literal("instruction"),
		Type.Literal("assistant-prefill"),
	]),
	// A Continuation instruction must contain non-whitespace content.
	continuationInstruction: Type.String({ pattern: "\\S" }),
	// Suffixes are intentionally a closed set. They are request-time
	// formatting choices, not authored Conversation content.
	continuationPrefillSuffix: Type.Union([
		Type.Literal(""),
		Type.Literal(" "),
		Type.Literal("\n"),
		Type.Literal("\n\n"),
	]),
	// Every API Format namespace is required so a switch between global
	// Connection Profiles can never transmit settings authored for another
	// wire format; each namespace keeps the open Generation JSON vocabulary.
	requestOverrides: Type.Object({
		"chat-completions": generationJsonObject,
		responses: generationJsonObject,
		"anthropic-messages": generationJsonObject,
	}),
});

export type CanonicalGenerationSettings = Static<typeof canonicalGenerationSettings>;
export type GenerationSettingsField = keyof CanonicalGenerationSettings;

// The settings update command's per-field requiredness policy. A canonical
// field is either required on the update command or optional — optional
// means a caller may omit it and the Conversation module fills it from
// stored values or established defaults. Compile-locked to the canonical
// vocabulary: adding a field fails typecheck until its update requiredness
// is stated, so a new field can never silently become update-required. The
// wire schema and the server domain input derive their optionality from
// this one policy, so the two cannot disagree about which fields may be
// absent.
export type GenerationSettingsUpdateFieldPolicy = "required" | "optional";

export const GENERATION_SETTINGS_UPDATE_FIELD_POLICY = {
	modelId: "required",
	temperature: "required",
	topP: "required",
	frequencyPenalty: "required",
	presencePenalty: "required",
	contextLimit: "required",
	responseBudget: "required",
	safetyAllowance: "optional",
	siblingGenerationLimit: "optional",
	continuationStrategy: "optional",
	continuationInstruction: "optional",
	continuationPrefillSuffix: "optional",
	requestOverrides: "required",
} as const satisfies GenerationSettingsFieldMap<GenerationSettingsUpdateFieldPolicy>;

export type GenerationSettingsUpdateOptionalField = {
	[K in GenerationSettingsField]: (typeof GENERATION_SETTINGS_UPDATE_FIELD_POLICY)[K] extends "optional"
		? K
		: never;
}[GenerationSettingsField];

// The update-optional vocabulary, derived from the policy map: the type
// projection above and this runtime filter read the same map, so they
// cannot drift from each other or from the canonical field list.
// SAFETY: the policy map is satisfies-locked to be total over the canonical
// field union, so its own keys are exactly the canonical fields; the cast
// only restores those literal key types from Object.keys' widening.
const generationSettingsPolicyKeys = Object.keys(
	GENERATION_SETTINGS_UPDATE_FIELD_POLICY,
) as GenerationSettingsField[];

export const GENERATION_SETTINGS_UPDATE_OPTIONAL_FIELDS =
	generationSettingsPolicyKeys.filter(
		(field): field is GenerationSettingsUpdateOptionalField =>
			GENERATION_SETTINGS_UPDATE_FIELD_POLICY[field] === "optional",
	);

// The canonical field vocabulary, compile-locked to the schema's own keys:
// adding or renaming a canonical field fails typecheck until this record
// names it, and the focused test keeps the runtime list aligned with the
// schema's own property order.
const canonicalGenerationSettingsFieldFlags = {
	modelId: null,
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
	requestOverrides: null,
} as const satisfies Record<GenerationSettingsField, null>;

// The canonical field vocabulary in declaration order.
// SAFETY: the satisfies lock on the flag record proves its keys are exactly
// the canonical field union, so this key list is the vocabulary itself.
const generationSettingsFieldKeys = Object.keys(
	canonicalGenerationSettingsFieldFlags,
) as readonly GenerationSettingsField[];

export const GENERATION_SETTINGS_FIELDS = generationSettingsFieldKeys;

// Explicit adapters have genuinely different semantics — nullable
// provenance records, Model Client transport input, safe inspection
// display — and cannot derive mechanically from the canonical declaration.
// Each adapter declares, per canonical field, whether it projects the field
// onto its own shape or intentionally excludes it; the mapped type makes a
// missing or unknown field a compile error.
export type GenerationSettingsFieldDisposition =
	| { readonly disposition: "projected" }
	| { readonly disposition: "excluded"; readonly reason: string };

export type GenerationSettingsAdapter = {
	readonly [K in GenerationSettingsField]: GenerationSettingsFieldDisposition;
};

// A total per-field value map for adapters that map fields onto their own
// vocabulary — database columns, plan slots, applicability decisions.
export type GenerationSettingsFieldMap<T> = {
	readonly [K in GenerationSettingsField]: T;
};

export interface NamedGenerationSettingsAdapter<T extends GenerationSettingsAdapter = GenerationSettingsAdapter> {
	readonly adapter: string;
	readonly fields: T;
}

// Constructs a named adapter declaration and re-proves completeness at
// runtime. The compile-time mapped type already enforces totality for typed
// declarations; this check keeps cast, test-authored, or dynamically built
// declarations honest. A declaration that misses a canonical field, names
// an unknown one, or excludes a field without a stated reason is rejected
// instead of silently accepted. The declared literal field dispositions are
// preserved on the result so downstream types can derive their projected
// vocabulary from the adapter's own decisions.
export const defineGenerationSettingsAdapter = <T extends GenerationSettingsAdapter>(
	adapter: string,
	fields: T,
): NamedGenerationSettingsAdapter<T> => {
	if (adapter.trim() === "") {
		throw new Error("A Generation Settings adapter must be named.");
	}
	// SAFETY: the parameter type guarantees the canonical dispositions; the
	// record view only supports rejecting declarations that reach this
	// constructor through a cast or dynamic construction.
	const declared = fields as Readonly<Record<string, GenerationSettingsFieldDisposition | undefined>>;
	const known = new Set<string>(GENERATION_SETTINGS_FIELDS);
	for (const field of Object.keys(declared)) {
		if (!known.has(field)) {
			throw new Error(
				`Generation Settings adapter '${adapter}' declares unknown field '${field}'.`,
			);
		}
	}
	for (const field of GENERATION_SETTINGS_FIELDS) {
		const disposition = declared[field];
		if (disposition === undefined) {
			throw new Error(
				`Generation Settings adapter '${adapter}' does not declare a disposition for '${field}'.`,
			);
		}
		if (disposition.disposition !== "projected" && disposition.disposition !== "excluded") {
			throw new Error(
				`Generation Settings adapter '${adapter}' declares an unknown disposition for '${field}'.`,
			);
		}
		if (disposition.disposition === "excluded" && disposition.reason.trim() === "") {
			throw new Error(
				`Generation Settings adapter '${adapter}' excludes '${field}' without a stated reason.`,
			);
		}
	}
	return { adapter, fields: { ...fields } };
};
