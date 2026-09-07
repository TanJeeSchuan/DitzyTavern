import { Type, type Static } from "@sinclair/typebox";

// ==[HUMAN APPROVED]== A Referenced Prompt Block names Conversation or Participant Definition
// content rather than text authored in the preset. Version one's vocabulary
// is exactly the content the native five-field Prompt model and the selected
// narrative path can supply; the owner prefix states which controlled
// Participant's Definition supplies the slot.
const referencedDefinitionBlocks = [
	Type.Literal("model-system-instruction"),
	Type.Literal("human-identity"),
	Type.Literal("model-identity"),
	Type.Literal("model-scenario"),
	Type.Literal("model-example-dialogue"),
	Type.Literal("model-post-history-instruction"),
] as const;

export const referencedDefinitionBlock = Type.Union([...referencedDefinitionBlocks]);
export type ReferencedDefinitionBlock = Static<typeof referencedDefinitionBlock>;

export const promptBlockReference = Type.Union([
	...referencedDefinitionBlocks,
	Type.Literal("history"),
]);
export type PromptBlockReference = Static<typeof promptBlockReference>;

// ==[HUMAN APPROVED]== One ordered slot of a recipe. Enablement lives on the slot so a disabled
// slot keeps its place in the order instead of disappearing from it.
export const promptPresetSlot = Type.Object({
	reference: promptBlockReference,
	enabled: Type.Boolean(),
});
export type PromptPresetSlot = Static<typeof promptPresetSlot>;

/** A stored Prompt Preset: the ordered recipe Generation assembles through. */
export const promptPresetRecipe = Type.Object({
	id: Type.Integer(),
	name: Type.String(),
	slots: Type.Array(promptPresetSlot),
});
export type PromptPresetRecipe = Static<typeof promptPresetRecipe>;

// ==[HUMAN APPROVED]== The read-only resolution one Chat sees. A Definition slot carries the
// Participant it reads and that Participant's authored source text; the
// history slot carries the number of selected narrative path entries it
// contributes, because its content is Messages rather than authored text.
// `sourceName` is null when the Conversation has no Participant in that
// Control seat.
export const resolvedPromptPresetSlot = Type.Union([
	Type.Object({
		reference: referencedDefinitionBlock,
		enabled: Type.Boolean(),
		sourceName: Type.Union([Type.Null(), Type.String()]),
		content: Type.String(),
	}),
	Type.Object({
		reference: Type.Literal("history"),
		enabled: Type.Boolean(),
		entryCount: Type.Integer(),
	}),
]);
export type ResolvedPromptPresetSlot = Static<typeof resolvedPromptPresetSlot>;

export const conversationPromptPreset = Type.Object({
	id: Type.Integer(),
	name: Type.String(),
	slots: Type.Array(resolvedPromptPresetSlot),
});
export type ConversationPromptPreset = Static<typeof conversationPromptPreset>;
