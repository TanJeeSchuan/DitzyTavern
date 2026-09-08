// ==[HUMAN APPROVED]== The shared Prompt Preset library seam. A preset is an ordered assembly
// recipe and nothing else; Generation Settings, Connection Profiles and text
// processing stay outside it. Every Conversation selects one preset, and the
// Default preset is ordinary stored content rather than a compiler branch, so
// editing it changes assembly without touching this module.

export {
	readConversationPromptPresetRecipe,
	readDefaultPromptPresetId,
	readPromptPresetRecipe,
	selectConversationPromptPreset,
	selectDefaultPromptPreset,
} from "./recipe";
export {
	executePromptPresetCommand,
	importSillyTavernPromptPreset,
	importNativePromptPreset,
	listPromptPresets,
	readNativePromptPreset,
} from "./library";
export {
	isSillyTavernJsonValue,
	normalizeSillyTavernImportRequest,
	reviewSillyTavernPromptPreset,
} from "./sillytavern";
export {
	addPromptPresetBlock,
	addPromptPresetInstruction,
	duplicatePromptPresetBlock,
	InvalidPromptPresetOperationError,
	movePromptPresetBlock,
	PromptPresetBlockNotFoundError,
	removePromptPresetBlock,
	savePromptPresetBlockPatches,
	setPromptPresetBlockContent,
	setPromptPresetBlockEnabled,
	setPromptPresetBlockRole,
} from "./blocks";
export {
	DefaultPromptPresetNotRemovableError,
	InvalidPromptPresetCommandError,
	PromptPresetDeletionImpactChangedError,
	PromptPresetNotFoundError,
	StalePromptPresetRevisionError,
} from "./errors";
export { resolveConversationPromptPreset } from "./resolve";
export type {
	PromptBlockReference,
	PromptPresetBlockPatch,
	PromptPresetRecipe,
	PromptPresetSlot,
	ReferencedDefinitionBlock,
} from "../../shared/contract/prompt-preset";
