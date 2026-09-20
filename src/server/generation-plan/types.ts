// Generation Plan contract (ADR-0032). The outer compiler owns intent
// applicability, budgeting, and active API Format selection for Request
// Overrides; the pure Prompt Compiler from ADR-0014 remains its internal
// implementation. These types describe the one complete plan every
// Generation workflow consumes.

import type { ConnectionApiFormat } from "../connection-settings/types";
import type {
	CanonicalGenerationSettings,
	EffectiveGenerationSettings,
} from "../../shared/contract/generation-settings";
import type { AttemptEnvironment } from "../../shared/prompt-macro-engine";
import type { LoreActivationRecord } from "../../shared/contract/lore-activation";

export type { PromptLoreEntry } from "../prompt-compiler";
import type { PromptPresetSlot } from "../../shared/contract/prompt-preset";
import type {
	CompilePromptDefinition,
	GenerationIntent,
	PromptBudgetResult,
	PromptContextEntry,
	PromptPlan,
	PromptLoreEntry,
	TokenEstimator,
} from "../prompt-compiler";

/**
 * The Generation Settings that actually participate in one Generation
 * attempt. Effective means DitzyTavern used a value locally or supplied it
 * to the selected Model Client adapter; it never claims a remote provider
 * honored the value. Tail and Sibling attempts have no applicable
 * Continuation strategy operand, an instruction Continuation retains only
 * its instruction, and an assistant-prefill Continuation retains only its
 * Prefill suffix.
 */
export type { EffectiveGenerationSettings } from "../../shared/contract/generation-settings";

/**
 * The complete application plan for one Generation attempt: its Prompt Plan,
 * budget decision, and Effective Generation Settings.
 */
export interface GenerationPlan {
	readonly promptPlan: PromptPlan;
	readonly budget: PromptBudgetResult;
	readonly effectiveSettings: EffectiveGenerationSettings;
	readonly loreActivation: LoreActivationRecord | null;
}

/**
 * The safe Connection facts compilation consumes: the selected Profile's API
 * Format. Resolution happens before compilation so only the matching
 * Request Overrides namespace participates; credentials, headers, and
 * connection URLs stay behind the transport seam and never reach the
 * compiler or the plan.
 */
export interface GenerationConnectionFacts {
	readonly apiFormat: ConnectionApiFormat;
}

/** The captured inputs one compilation consumes. */
export interface CompileGenerationPlanInput {
	// Captured Conversation state: the resolved Participant Definitions and
	// the ordered writing context for this one attempt. Each entry carries
	// its own role, so nothing aligns a second list against this one.
	readonly human: CompilePromptDefinition;
	readonly model: CompilePromptDefinition;
	readonly context: readonly PromptContextEntry[];
	// The selected Prompt Preset's ordered recipe, captured with the rest of
	// the attempt's inputs so execution never rereads mutable preset state.
	readonly recipe: readonly PromptPresetSlot[];
	/** Captured lore candidates. They are admitted once before history trimming. */
	readonly lore?: readonly PromptLoreEntry[];
	/** Chat-owned estimated-token allowance for the Lore block. */
	readonly loreAllowance?: number;
	/** Captured activation evidence. It is never recomputed during budgeting. */
	readonly loreActivation?: LoreActivationRecord | null;
	// The Generation intent this attempt serves. An ordinary Tail Generation
	// carries no intent; a Continuation or Sibling attempt carries its own.
	readonly intent?: GenerationIntent | undefined;
	// The canonical Generation Settings captured for the attempt.
	readonly settings: CanonicalGenerationSettings;
	// The safe Connection facts resolved before compilation. Null when no
	// Profile is active — no Request Overrides namespace applies then.
	readonly connection: GenerationConnectionFacts | null;
	// One attempt's captured macro inputs and state. Keeping them together makes
	// reuse across every budget candidate part of the type contract.
	readonly attempt?: AttemptEnvironment;
	// Tests and calibration work may replace the default project-owned
	// estimator; budgeting policy itself stays application-owned.
	readonly estimator?: TokenEstimator | undefined;
}
