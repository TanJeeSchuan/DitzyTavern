// ==[HUMAN APPROVED]== Deep, pure Prompt Compiler seam. Compiles resolved Participant Definitions
// and one ordered writing context into a deterministic provider-neutral
// Prompt Plan. No SQLite, HTTP, credentials, or provider vocabulary.

export {
	compileOpening,
	compilePrompt,
	referencedDefinitionBlocks,
} from "./compiler";
export {
	budgetPromptPlan,
	budgetEditedPromptPlan,
	PromptBudgetExceededError,
	toEstimationTranscript,
	tokenxEstimator,
} from "./budget";
export type {
	CompilePromptDefinition,
	CompilePromptInput,
	GenerationIntent,
	MacroEnvironment,
	PromptBlock,
	PromptContextEntry,
	PromptHistoryRole,
	PromptPlan,
	PromptWarning,
} from "./types";
export type {
	PromptBudgetBreakdown,
	PromptBudgetFailure,
	PromptBudgetInput,
	PromptBudgetResult,
	TokenEstimator,
} from "./budget";
