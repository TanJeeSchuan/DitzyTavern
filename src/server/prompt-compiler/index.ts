// ==[HUMAN APPROVED]== Deep, pure Prompt Compiler seam. Compiles resolved Participant Definitions
// and one ordered writing context into a deterministic provider-neutral
// Prompt Plan. No SQLite, HTTP, credentials, or provider vocabulary.

export {
	compileOpening,
	compilePrompt,
	referencedDefinitionBlocks,
} from "./compiler";
export { resolvePromptImages, type ImageLookup } from "./images";
export {
	budgetPromptPlan,
	budgetEditedPromptPlan,
	measurePromptPlan,
	PromptBudgetExceededError,
	toEstimationTranscript,
	tokenxEstimator,
} from "./budget";
export type {
	CompilePromptDefinition,
	PromptLoreEntry,
	CompilePromptInput,
	GenerationIntent,
	MacroEnvironment,
	MacroAttemptState,
	PromptBlock,
	PromptContextEntry,
	PromptHistoryRole,
	PromptImage,
	PromptPlan,
	PromptWarning,
} from "./types";
export type {
	PromptBudgetBreakdown,
	PromptBudgetFailure,
	PromptBudgetInput,
	PromptBudgetResult,
	PromptBudgetMeasurement,
	PromptBudgetMeasurementInput,
	TokenEstimator,
} from "./budget";
