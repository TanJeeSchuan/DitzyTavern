import { Kind, Type, type Static } from "@sinclair/typebox";
import type { GenerationJsonValue } from "../generation-json";

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

// The settings an individual attempt actually uses. Continuation operands and
// the configured sibling limit are nullable when they do not participate in
// that attempt; request overrides have already been narrowed to the active
// API Format. Keep this beside the canonical declaration so the preview
// response validates the same shape the Generation Plan produces.
export const effectiveGenerationSettings = Type.Object({
	...Type.Omit(canonicalGenerationSettings, ["siblingGenerationLimit", "continuationStrategy", "continuationInstruction", "continuationPrefillSuffix", "requestOverrides"]).properties,
	siblingGenerationLimit: Type.Union([Type.Null(), canonicalGenerationSettings.properties.siblingGenerationLimit]),
	continuationStrategy: Type.Union([Type.Null(), canonicalGenerationSettings.properties.continuationStrategy]),
	continuationInstruction: Type.Union([Type.Null(), canonicalGenerationSettings.properties.continuationInstruction]),
	continuationPrefillSuffix: Type.Union([Type.Null(), canonicalGenerationSettings.properties.continuationPrefillSuffix]),
	requestOverrides: generationJsonObject,
});

export type EffectiveGenerationSettings = Static<typeof effectiveGenerationSettings>;

export type CanonicalGenerationSettings = Static<typeof canonicalGenerationSettings>;
export type GenerationSettingsField = keyof CanonicalGenerationSettings;

// The canonical field vocabulary, read from the canonical schema's own keys:
// the schema is the one canonical declaration of the Generation Settings
// structure (ADR-0032), so this runtime key list cannot drift from it and
// keeps the schema's declaration order.
// SAFETY: the schema's properties are declared with the canonical literal
// keys; this cast only restores those literal key types from Object.keys'
// widening.
const canonicalGenerationSettingsKeys = Object.keys(
	canonicalGenerationSettings.properties,
) as readonly GenerationSettingsField[];

export const GENERATION_SETTINGS_FIELDS = canonicalGenerationSettingsKeys;
