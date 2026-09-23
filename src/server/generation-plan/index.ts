// ==[HUMAN APPROVED]== Deep Generation Plan seam (ADR-0032). The principal server planning
// interface: one deterministic compiler turns captured Conversation state,
// Generation intent, canonical Generation Settings, and the safe Connection
// facts into the complete plan used by inspection and execution.

export {
	assertGenerationPlan,
	compileGenerationPlan,
	continuationIntentFor,
	estimateDynamicBlockTokens,
	effectiveGenerationSettingsFor,
} from "./compiler";
export type {
	CompileGenerationPlanInput,
	EffectiveGenerationSettings,
	GenerationConnectionFacts,
	GenerationPlan,
	PromptLoreEntry,
} from "./types";
