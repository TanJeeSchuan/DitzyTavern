// Generation Plan contract (ADR-0032). The outer compiler owns intent
// applicability, budgeting, and active API Format selection for Request
// Overrides; the pure Prompt Compiler from ADR-0014 remains its internal
// implementation. These types describe the one complete plan every
// Generation workflow consumes.

import type { ConnectionApiFormat } from "../connection-settings/types";
import type { GenerationJsonObject } from "../../shared/generation-provenance";
import type {
	CanonicalGenerationSettings,
	GenerationSettingsField,
} from "../../shared/contract/generation-settings";
import type {
	CompilePromptDefinition,
	GenerationIntent,
	PromptBudgetResult,
	PromptContextEntry,
	PromptPlan,
	TokenEstimator,
} from "../prompt-compiler";

// The value one canonical field takes in the Effective Generation Settings:
// every field keeps its configured value except the three Continuation
// fields and the currently unenforced Sibling Generation limit. A value that
// did not participate is null rather than copied. Request Overrides narrow
// to the active API Format namespace.
type EffectiveFieldValue<K extends GenerationSettingsField> = K extends
	| "continuationStrategy"
	| "continuationInstruction"
	| "continuationPrefillSuffix"
	| "siblingGenerationLimit"
	? CanonicalGenerationSettings[K] | null
	: K extends "requestOverrides"
		? GenerationJsonObject
		: CanonicalGenerationSettings[K];

/**
 * The Generation Settings that actually participate in one Generation
 * attempt. Effective means DitzyTavern used a value locally or supplied it
 * to the selected Model Client adapter; it never claims a remote provider
 * honored the value. Tail and Sibling attempts have no applicable
 * Continuation strategy operand, an instruction Continuation retains only
 * its instruction, and an assistant-prefill Continuation retains only its
 * Prefill suffix.
 */
export type EffectiveGenerationSettings = {
	readonly [K in GenerationSettingsField]: EffectiveFieldValue<K>;
};

/**
 * The complete application plan for one Generation attempt: its Prompt Plan,
 * budget decision, and Effective Generation Settings.
 */
export interface GenerationPlan {
	readonly promptPlan: PromptPlan;
	readonly budget: PromptBudgetResult;
	readonly effectiveSettings: EffectiveGenerationSettings;
}

/**
 * The safe Connection facts compilation consumes: the active Profile's API
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
	// The Generation intent this attempt serves. An ordinary Tail Generation
	// carries no intent; a Continuation or Sibling attempt carries its own.
	readonly intent?: GenerationIntent | undefined;
	// The canonical Generation Settings captured for the attempt.
	readonly settings: CanonicalGenerationSettings;
	// The safe Connection facts resolved before compilation. Null when no
	// Profile is active — no Request Overrides namespace applies then.
	readonly connection: GenerationConnectionFacts | null;
	// Tests and calibration work may replace the default project-owned
	// estimator; budgeting policy itself stays application-owned.
	readonly estimator?: TokenEstimator | undefined;
}
