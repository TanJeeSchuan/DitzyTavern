// ==[HUMAN APPROVED]== The shared Prompt Preset library seam. A preset is an ordered assembly
// recipe and nothing else; Generation Settings, Connection Profiles and text
// processing stay outside it. Every Conversation selects one preset, and the
// Default preset is ordinary stored content rather than a compiler branch, so
// editing it changes assembly without touching this module.

export {
	readConversationPromptPresetRecipe,
	readDefaultPromptPresetId,
	readPromptPresetRecipe,
	selectDefaultPromptPreset,
} from "./recipe";
export {
	addPromptPresetBlock,
	InvalidPromptPresetOperationError,
	movePromptPresetBlock,
	PromptPresetBlockNotFoundError,
	PromptPresetNotFoundError,
	removePromptPresetBlock,
	setPromptPresetBlockEnabled,
	setPromptPresetBlockRole,
	duplicatePromptPresetBlock,
} from "./blocks";
export { resolveConversationPromptPreset } from "./resolve";
export type {
	PromptBlockReference,
	PromptPresetRecipe,
	PromptPresetSlot,
	ReferencedDefinitionBlock,
} from "../../shared/contract/prompt-preset";
