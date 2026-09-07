import { Type, type Static } from "@sinclair/typebox";
import { notRemovableOutcome } from "./outcomes";

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

// ==[HUMAN APPROVED]== The library entry every preset list shows. `conversationCount` is
// the deletion impact presented with every authoritative read, exactly like
// the Character Library's provenance reference count: the confirmation flow
// shows how many Conversations move to Default before any command, while the
// command itself derives the authoritative reassignment at execution time.
export const promptPresetSummary = Type.Object({
	id: Type.Integer(),
	name: Type.String(),
	revision: Type.Integer(),
	isDefault: Type.Boolean(),
	conversationCount: Type.Integer(),
});
export type PromptPresetSummary = Static<typeof promptPresetSummary>;

export const promptPresetListResponse = Type.Object({
	presets: Type.Array(promptPresetSummary),
});
export type PromptPresetListResponse = Static<typeof promptPresetListResponse>;

// Creation names a blank recipe; the recipe stays empty until the editor
// tickets add block operations.
export const promptPresetCreateCommand = Type.Object({
	type: Type.Literal("create"),
	name: Type.String(),
});

// ==[HUMAN APPROVED]== Every mutation except creation guards the revision the caller saw,
// matching the Character Library convention. Duplicate carries the new
// preset's name so naming stays an explicit library operation.
export const promptPresetRenameCommand = Type.Object({
	type: Type.Literal("rename"),
	presetId: Type.Integer(),
	expectedRevision: Type.Integer(),
	name: Type.String(),
});

export const promptPresetDuplicateCommand = Type.Object({
	type: Type.Literal("duplicate"),
	presetId: Type.Integer(),
	expectedRevision: Type.Integer(),
	name: Type.String(),
});

// ==[HUMAN APPROVED]== Confirmed deletion. The expected revision guards against deleting a
// preset whose affected-Conversation count the caller has not seen; the
// outcome derives the authoritative reassignment at command time.
export const promptPresetDeleteCommand = Type.Object({
	type: Type.Literal("delete"),
	presetId: Type.Integer(),
	expectedRevision: Type.Integer(),
});

export const promptPresetCommandBody = Type.Union([
	promptPresetCreateCommand,
	promptPresetRenameCommand,
	promptPresetDuplicateCommand,
	promptPresetDeleteCommand,
]);
export type PromptPresetCommand = Static<typeof promptPresetCommandBody>;

// ==[HUMAN APPROVED]== Outcome of a confirmed deletion: the reassignment count is derived
// from the selections present at command time, never guessed by the client.
export const promptPresetDeletionResult = Type.Object({
	presetId: Type.Integer(),
	reassignedConversationCount: Type.Integer(),
});
export type PromptPresetDeletionResult = Static<typeof promptPresetDeletionResult>;

// Deletion returns the typed reassignment result instead of a summary; every
// other command returns the authoritative updated preset.
export const promptPresetCommandApplied = Type.Union([
	Type.Object({
		outcome: Type.Literal("applied"),
		preset: promptPresetSummary,
	}),
	Type.Object({
		outcome: Type.Literal("applied"),
		result: promptPresetDeletionResult,
	}),
]);
export type PromptPresetCommandApplied = Static<typeof promptPresetCommandApplied>;

// Stale-revision conflict carrying the authoritative current preset so the
// caller can recover without a follow-up read.
export const promptPresetConflict = Type.Object({
	outcome: Type.Literal("conflict"),
	expectedRevision: Type.Integer(),
	actualRevision: Type.Integer(),
	currentPreset: promptPresetSummary,
});
export type PromptPresetConflict = Static<typeof promptPresetConflict>;

// ==[HUMAN APPROVED]== The command route's typed 409 payload: the recoverable stale
// revision conflict, or the refusal of a Default deletion.
export const promptPresetCommandConflict = Type.Union([
	promptPresetConflict,
	notRemovableOutcome,
]);
