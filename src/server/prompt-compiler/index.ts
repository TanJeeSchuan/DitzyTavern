// ==[HUMAN APPROVED]== Deep, pure Prompt Compiler seam. Compiles resolved Participant Definitions
// and normalized selected history into a deterministic provider-neutral
// Prompt Plan. No SQLite, HTTP, credentials, or provider vocabulary.

export { compileOpening, compilePrompt, expandText } from "./compiler";
export {
	budgetPromptPlan,
	PromptBudgetExceededError,
	toEstimationTranscript,
	tokenxEstimator,
} from "./budget";
export type {
	CompilePromptDefinition,
	CompilePromptInput,
	ExpansionResult,
	GenerationIntent,
	MacroContext,
	PromptBlock,
	PromptHistoryEntry,
	PromptPlan,
	PromptWarning,
} from "./types";
export type {
	PromptBudgetBreakdown,
	PromptBudgetFailure,
	PromptBudgetInput,
	PromptBudgetResult,
	PromptHistoryRole,
	TokenEstimator,
} from "./budget";
