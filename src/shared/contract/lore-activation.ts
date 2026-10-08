import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { GenerationJsonValue } from "../generation-json";

// Lore evidence is deliberately provider-neutral JSON. The recursive declaration keeps the
// persisted record closed to serialisable values while allowing the matcher to evolve its
// evidence fields under the record's explicit version.
export const loreActivationEvidence = Type.Unsafe<GenerationJsonValue>(Type.Recursive((self) => Type.Union([
	Type.String(),
	Type.Number(),
	Type.Boolean(),
	Type.Null(),
	Type.Array(self),
	Type.Record(Type.String(), self),
])));

export type LoreActivationEvidence = Static<typeof loreActivationEvidence>;


export const loreActivationRecord = Type.Object({
	version: Type.Literal(1),
	mode: Type.Union([
		Type.Literal("semantic"),
		Type.Literal("keyword-fallback"),
		Type.Literal("none"),
	]),
	evidence: loreActivationEvidence,
	automaticLoreText: Type.String(),
	finalLoreText: Type.String(),
	manuallyEdited: Type.Boolean(),
});

export type LoreActivationRecord = Static<typeof loreActivationRecord> & {
	readonly [key: string]: GenerationJsonValue;
};

export const isLoreActivationRecord = (value: GenerationJsonValue): value is LoreActivationRecord =>
	Value.Check(loreActivationRecord, value);
