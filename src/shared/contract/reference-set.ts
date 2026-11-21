import { Type, type Static } from "@sinclair/typebox";

export const referenceSet = Type.Object({ id: Type.String(), name: Type.String({ minLength: 1 }), references: Type.String() });
export type ReferenceSet = Static<typeof referenceSet>;
export const referenceSetCommand = Type.Union([
	Type.Object({ type: Type.Literal("create-reference-set"), name: referenceSet.properties.name, references: Type.String() }),
	Type.Object({ type: Type.Literal("adopt-reference-set"), name: referenceSet.properties.name, references: Type.String() }),
	Type.Object({ type: Type.Literal("save-reference-set"), id: Type.String(), references: Type.String() }),
	Type.Object({ type: Type.Literal("rename-reference-set"), id: Type.String(), name: referenceSet.properties.name }),
	Type.Object({ type: Type.Literal("select-reference-set"), id: Type.String() }),
	Type.Object({ type: Type.Literal("delete-reference-set"), id: Type.String() }),
]);
export type ReferenceSetCommand = Static<typeof referenceSetCommand>;
