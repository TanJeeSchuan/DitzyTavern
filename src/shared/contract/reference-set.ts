import { Type, type Static } from "@sinclair/typebox";

export const referenceSet = Type.Object({ id: Type.String(), name: Type.String({ minLength: 1 }), references: Type.String() });
export type ReferenceSet = Static<typeof referenceSet>;
const referenceDraftText = Type.Object({ base: referenceSet.properties.references, references: referenceSet.properties.references });
export type ReferenceDraftText = Static<typeof referenceDraftText>;
export const referenceDraft = Type.Record(Type.String(), referenceDraftText);
export const referenceSetSelection = Type.Object({ referenceSets: Type.Array(referenceSet, { minItems: 1 }), referenceSetId: Type.String() });
export type ReferenceSetSelection = Static<typeof referenceSetSelection>;
export const referenceSetCommand = Type.Union([
	Type.Object({ type: Type.Literal("create-reference-set"), name: referenceSet.properties.name, references: Type.String() }),
	Type.Object({ type: Type.Literal("adopt-reference-set"), name: referenceSet.properties.name, references: Type.String() }),
	Type.Object({ type: Type.Literal("save-reference-set"), id: Type.String(), expectedReferences: Type.String(), references: Type.String() }),
	Type.Object({ type: Type.Literal("rename-reference-set"), id: Type.String(), name: referenceSet.properties.name }),
	Type.Object({ type: Type.Literal("select-reference-set"), id: Type.String() }),
	Type.Object({ type: Type.Literal("delete-reference-set"), id: Type.String() }),
]);
export type ReferenceSetCommand = Static<typeof referenceSetCommand>;

export const referenceSetConflict = Type.Object({ outcome: Type.Literal("reference-set-conflict"), current: referenceSet });
