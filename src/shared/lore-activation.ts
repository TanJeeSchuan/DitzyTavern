import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { GenerationJsonValue } from "./generation-json";

// ==[HUMAN APPROVED]== Lore evidence is owned by a retained Variant. It is deliberately separate from
// the generic Variant-data namespace so clients cannot rewrite an explanation.
export const LORE_ACTIVATION_NAMESPACE = "lore-activation";
export const LORE_ACTIVATION_KEY = "record";

export const loreActivationRecord = Type.Object({
	version: Type.Literal(1),
	mode: Type.Union([
		Type.Literal("semantic"),
		Type.Literal("keyword-fallback"),
		Type.Literal("none"),
	]),
	// ==[HUMAN APPROVED]== The matcher owns the evidence vocabulary. Keeping the captured payload as
	// closed JSON lets lexical and semantic slices add evidence without leaking
	// provider objects, credentials, or database rows through this boundary.
	evidence: Type.Any(),
	automaticLoreText: Type.String(),
	finalLoreText: Type.String(),
	manuallyEdited: Type.Boolean(),
});
export interface LoreActivationRecord {
	readonly [key: string]: GenerationJsonValue;
	readonly version: 1;
	readonly mode: "semantic" | "keyword-fallback" | "none";
	readonly evidence: GenerationJsonValue;
	readonly automaticLoreText: string;
	readonly finalLoreText: string;
	readonly manuallyEdited: boolean;
}

export const isLoreActivationNamespace = (namespace: string): boolean =>
	namespace === LORE_ACTIVATION_NAMESPACE;

export const isLoreActivationRecord = (value: GenerationJsonValue): value is LoreActivationRecord =>
	Value.Check(loreActivationRecord, value);
