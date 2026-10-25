import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { generationJsonValue, type GenerationJsonValue } from "./json-value";

export const loreActivationRecord = Type.Object({
	version: Type.Literal(1),
	mode: Type.Union([
		Type.Literal("semantic"),
		Type.Literal("keyword-fallback"),
		Type.Literal("none"),
	]),
	evidence: generationJsonValue,
	automaticLoreText: Type.String(),
	finalLoreText: Type.String(),
	manuallyEdited: Type.Boolean(),
});

export type LoreActivationRecord = Static<typeof loreActivationRecord> & {
	readonly [key: string]: GenerationJsonValue;
};

export const isLoreActivationRecord = (value: GenerationJsonValue): value is LoreActivationRecord =>
	Value.Check(loreActivationRecord, value);
