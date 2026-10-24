import { Type, type Static } from "@sinclair/typebox";

export const boxMetadataSchema = Type.Object({
	id: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
	label: Type.String(),
	summary: Type.String(),
	instructions: Type.String(),
	block: Type.Optional(Type.Object({ description: Type.String(), source: Type.String() })),
	decision: Type.Optional(Type.Object({ summary: Type.String(), description: Type.String(), off: Type.String(), context: Type.String() })),
});
export type BoxMetadata = Static<typeof boxMetadataSchema>;
