import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const generationIntent = Type.Union([
	Type.Object({ type: Type.Literal("sibling") }),
	Type.Object({
		type: Type.Literal("continuation"),
		strategy: Type.Literal("instruction"),
		instruction: Type.String(),
		// @approved
		//  Set when Strict System Placement sends the instruction as a human
		// message instead of a trailing system message.
		demoted: Type.Optional(Type.Literal(true)),
	}),
	Type.Object({
		type: Type.Literal("continuation"),
		strategy: Type.Literal("assistant-prefill"),
		suffix: Type.Union([
			Type.Literal(""),
			Type.Literal(" "),
			Type.Literal("\n"),
			Type.Literal("\n\n"),
		]),
	}),
]);

export const storedGenerationIntent = Type.Union([Type.Object({ type: Type.Literal("tail") }), generationIntent]);
export type StoredGenerationIntent = Static<typeof storedGenerationIntent>;

export function decodeGenerationIntent(serialized: string): StoredGenerationIntent {
	const parsed: unknown = JSON.parse(serialized);
	if (!Value.Check(storedGenerationIntent, parsed)) throw new Error("The Active Generation has invalid persisted Generation intent.");
	return parsed;
}
