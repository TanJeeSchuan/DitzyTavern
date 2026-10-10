import { Type, type Static } from "@sinclair/typebox";

// @approved
//  Every compiled-in Box (ADR-0050). A Box's preset reference and its data
// namespace are both `box:<id>`.
export const boxIds = ["author-note"] as const;
export type BoxId = typeof boxIds[number];
export const boxId = Type.Union(boxIds.map((id) => Type.Literal(id)));

export const promptBoxReference = Type.TemplateLiteral([Type.Literal("box:"), boxId]);
export type PromptBoxReference = Static<typeof promptBoxReference>;
export const boxReference = (id: BoxId): PromptBoxReference => `box:${id}`;
export const isBoxReference = (reference: string): reference is PromptBoxReference =>
	boxIds.some((id) => boxReference(id) === reference);

// @approved
//  Each Box's Conversation-scoped setup, as the Chat summary carries it and
// the set-box-setup command writes it. The Author Note's setup is its text,
// Image References included.
export const boxSetups = Type.Object({ "author-note": Type.String() });
export type BoxSetups = Static<typeof boxSetups>;
