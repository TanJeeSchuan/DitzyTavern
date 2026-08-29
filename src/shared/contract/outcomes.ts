import { Type } from "@sinclair/typebox";

// Transport outcome envelopes shared by every route family: the typed
// not-found, invalid, not-playable, not-removable, and reason-only conflict
// payloads that error-mapping adapters compose into response maps.
export const notFoundOutcome = Type.Object({ outcome: Type.Literal("not-found") });

export const invalidOutcome = Type.Object({
	outcome: Type.Literal("invalid"),
	reason: Type.String(),
});

export const notPlayableOutcome = Type.Object({
	outcome: Type.Literal("not-playable"),
	reason: Type.String(),
});

export const notRemovableOutcome = Type.Object({
	outcome: Type.Literal("not-removable"),
	reason: Type.String(),
});

export const conflictReasonOutcome = Type.Object({
	outcome: Type.Literal("conflict"),
	reason: Type.String(),
});
