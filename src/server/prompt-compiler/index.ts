// ==[HUMAN APPROVED]== Deep, pure Prompt Compiler seam. Compiles resolved Participant Definitions
// and one ordered writing context into a deterministic provider-neutral
// Prompt Plan. No SQLite, HTTP, credentials, or provider vocabulary.

export {
	compileOpening,
	compilePrompt,
	referencedDefinitionBlocks,
} from "./compiler";
// ==[HUMAN APPROVED]== The shared macro engine is the single expansion implementation for
// Participant text, openings, and authored preset instruction blocks; the
// deep compiler seam re-exports it beside its own functions.
export { expandText } from "../../shared/prompt-macros";
export { expandMacroText, validateMacroText } from "../../shared/prompt-macro-engine";
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
	ExpansionResult,
	GenerationIntent,
	MacroContext,
	MacroEnvironment,
	MacroExpansionResult,
	MacroValidationResult,
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
