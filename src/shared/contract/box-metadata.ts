import { Type, type Static } from "@sinclair/typebox";

/** @approved The element name a Box's markup uses in prose, lowercase words joined by `-`: a delegate's request, or a lens's lifted text. */
export const boxTag = Type.String({ pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" });
/** @approved A delegating Box's tag and the copy for its delegate setting, which the catalog carries without the operations schema. */
export const boxDelegateCopy = Type.Object({ tag: boxTag, summary: Type.String(), description: Type.String(), off: Type.String() });

export const boxMetadataSchema = Type.Object({
	id: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
	label: Type.String(),
	summary: Type.String(),
	instructions: Type.String(),
	block: Type.Optional(Type.Object({ description: Type.String(), source: Type.String() })),
	decision: Type.Optional(Type.Object({ summary: Type.String(), description: Type.String(), off: Type.String(), context: Type.String() })),
	lens: Type.Optional(boxTag),
	delegate: Type.Optional(boxDelegateCopy),
});
export type BoxMetadata = Static<typeof boxMetadataSchema>;
