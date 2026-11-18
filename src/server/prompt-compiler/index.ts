// @approved
//  Deep, pure Prompt Compiler seam. Compiles resolved Participant Definitions
// and one ordered writing context into a deterministic provider-neutral
// Prompt Plan. No SQLite, HTTP, credentials, or provider vocabulary.

export {
	boxItemExpansionKey,
	compileOpening,
	compilePrompt,
	referencedDefinitionBlocks,
} from "./compiler";
export { resolvePromptImages, type ImageLookup, type PromptImageResolution } from "./images";
export {
	budgetPromptPlan,
	measurePromptPlan,
	PromptBudgetExceededError,
	toEstimationTranscript,
	tokenxEstimator,
	promptPlanEstimator,
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
	LiteralPromptMessage,
	PromptHistoryRole,
	PromptImage,
	PromptPlan,
	PromptWarning,
} from "./types";
export type {
	PromptBudgetBreakdown,
	PromptBudgetInput,
	PromptBudgetMeasurement,
	PromptBudgetMeasurementInput,
	TokenEstimator,
} from "./budget";
