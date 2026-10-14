import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { canonicalGenerationSettings, type GenerationSettingsField } from "./generation-settings";
import { generationFinishReason, generationUsage } from "./generation-events";

// Generation provenance is deliberately a small positive allow-list: it may
// carry safe identity, settings, usage, and terminal outcome metadata, but
// never provider payloads, URLs, headers, credentials, or request overrides.

// Every canonical Generation Settings field except model identity (captured
// beside the connection identity at provenance top level) and Request
// Overrides (never retained) participates in provenance.
type ProvenanceSettingsField = Exclude<GenerationSettingsField, "modelId" | "requestOverrides">;

const nullable = <T extends TSchema>(schema: T) => Type.Union([Type.Null(), schema]);

// Provenance describes one historical attempt, so every retained settings
// field widens to a nullable wire kind instead of reusing the capture-time
// validation domain, and a value that did not participate is null rather
// than an accidental zero or empty string. The satisfies lock makes a
// missing or unknown canonical field a compile error.
const provenanceSettingsSchemas = {
	temperature: nullable(Type.Number()),
	topP: nullable(Type.Number()),
	frequencyPenalty: nullable(Type.Number()),
	presencePenalty: nullable(Type.Number()),
	contextLimit: nullable(Type.Integer()),
	responseBudget: nullable(Type.Integer()),
	safetyAllowance: nullable(Type.Integer()),
	siblingGenerationLimit: nullable(Type.Integer()),
	continuationStrategy: nullable(canonicalGenerationSettings.properties.continuationStrategy),
	continuationInstruction: nullable(Type.String()),
	continuationPrefillSuffix: nullable(canonicalGenerationSettings.properties.continuationPrefillSuffix),
	repeatedImagePlacement: nullable(canonicalGenerationSettings.properties.repeatedImagePlacement),
} as const satisfies { readonly [K in ProvenanceSettingsField]: TSchema };

export const generationProvenanceStatus = Type.Union([
	Type.Literal("complete"),
	Type.Literal("length-limited"),
	Type.Literal("interrupted"),
]);

// The persisted provenance record. Null leads every union so the schema's
// created value is the all-unavailable record. A start-time record has no
// terminal status yet; the terminal record written beside the durable
// Variant carries one.
export const generationProvenanceRecord = Type.Object({
	connectionProfileId: nullable(Type.Integer()),
	connectionSettingsRevision: nullable(Type.Integer()),
	modelBackend: nullable(Type.String()),
	adapter: nullable(Type.String()),
	modelId: nullable(Type.String()),
	generationSettings: Type.Object(provenanceSettingsSchemas),
	usage: nullable(generationUsage),
	finishReason: nullable(generationFinishReason),
	status: nullable(generationProvenanceStatus),
	interruptionCause: nullable(Type.String()),
});

export type GenerationProvenanceRecord = Static<typeof generationProvenanceRecord>;
export type GenerationProvenanceSettings = GenerationProvenanceRecord["generationSettings"];

// The provenance a terminal Variant displays: the record with its status
// resolved.
export const generationProvenance = Type.Object({
	...generationProvenanceRecord.properties,
	status: generationProvenanceStatus,
});

export type GenerationProvenance = Static<typeof generationProvenance>;

// The terminal `finish` Variant data entry.
export const generationFinish = Type.Object({ reason: generationFinishReason });
