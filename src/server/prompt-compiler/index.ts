// Deep, pure Prompt Compiler seam. Compiles resolved Participant Definitions
// and normalized selected history into a deterministic provider-neutral
// Prompt Plan. No SQLite, HTTP, credentials, or provider vocabulary.

export { compileOpening, compilePrompt, expandText } from "./compiler";
export type {
	CompilePromptDefinition,
	CompilePromptInput,
	CompilePromptSource,
	ExpansionResult,
	MacroContext,
	PromptBlock,
	PromptHistoryEntry,
	PromptPlan,
	PromptWarning,
} from "./types";