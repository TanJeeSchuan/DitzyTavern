import { Type, type Static, type StaticDecode, type TObject, type TSchema } from "@sinclair/typebox";

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

const revisionConflictFields = {
	outcome: Type.Literal("conflict"),
	reason: Type.Literal("stale-revision"),
	expectedRevision: Type.Integer(),
	actualRevision: Type.Integer(),
};

export const revisionConflict = <S extends TSchema>(current: S) => Type.Object({ ...revisionConflictFields, current });

export type RevisionConflict<Current> = Static<TObject<typeof revisionConflictFields>> & { current: Current };

export type ResponseMap = Record<number, TSchema>;
export type ResponseErrorSchema<Map extends ResponseMap> = Map[Exclude<keyof Map, 200> & number];

// @approved
// TypeBox loses the decoded type for a union built from an array. Keep its
// runtime schema and derive the decoded type from the same map entries.
export const responseErrorSchema = <Map extends ResponseMap>({ 200: _success, ...errors }: Map) =>
	Type.Unsafe<StaticDecode<ResponseErrorSchema<Map>>>(Type.Union(Object.values(errors)));

// @approved
//  The read family's modeled error union: every typed read route declares
// the shared not-found and invalid envelopes as its only error responses.
export const readOutcomeErrors = Type.Union([notFoundOutcome, invalidOutcome]);
