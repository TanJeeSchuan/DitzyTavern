// ==[HUMAN APPROVED]== The principal Generation Plan Compiler (ADR-0032).
//
// One deterministic interface turns captured Conversation state, Generation
// intent, canonical Generation Settings, and the safe Connection facts into
// the complete Generation Plan used by inspection and execution. The pure
// Prompt Compiler from ADR-0014 remains the internal implementation: this
// module owns intent applicability, budgeting, and the active API Format
// selection for Request Overrides, while the Prompt Compiler keeps
// named-block ordering, macro expansion, and selected history.
//
// The module is pure: it never touches SQLite, HTTP, credentials, or
// provider vocabulary. Effective means DitzyTavern used a value locally or
// supplied it to the selected Model Client adapter — never that a remote
// provider honored it.

import {
	budgetPromptPlan,
	compilePrompt,
	PromptBudgetExceededError,
	type GenerationIntent,
	type PromptPlan,
	type PromptContextEntry,
} from "../prompt-compiler";
import type { CanonicalGenerationSettings } from "../../shared/contract/generation-settings";
import { createMacroAttemptState } from "../../shared/prompt-macro-engine";
import type {
	CompileGenerationPlanInput,
	EffectiveGenerationSettings,
	GenerationConnectionFacts,
	GenerationPlan,
} from "./types";

/**
 * ==[HUMAN APPROVED]== The Continuation intent one configured strategy produces. Instruction
 * Continuations carry the editable instruction and assistant-prefill
 * Continuations carry the closed Prefill suffix; the other operand never
 * applies. Inspection exposes this exact intent for the selected strategy.
 */
export const continuationIntentFor = (
	settings: CanonicalGenerationSettings,
): GenerationIntent => settings.continuationStrategy === "instruction"
	? {
		type: "continuation",
		strategy: "instruction",
		instruction: settings.continuationInstruction,
	}
	: {
		type: "continuation",
		strategy: "assistant-prefill",
		suffix: settings.continuationPrefillSuffix,
	};

// ==[HUMAN APPROVED]== The applicable Continuation operands for one attempt. Tail and Sibling
// attempts have none; a Continuation retains exactly the operand its
// strategy uses, so the effective settings can never imply that an
// inapplicable operand participated.
const continuationOperands = (
	intent: GenerationIntent | undefined,
): Pick<
	EffectiveGenerationSettings,
	"continuationStrategy" | "continuationInstruction" | "continuationPrefillSuffix"
> => {
	if (intent === undefined || intent.type === "sibling") {
		return {
			continuationStrategy: null,
			continuationInstruction: null,
			continuationPrefillSuffix: null,
		};
	}
	return intent.strategy === "instruction"
		? {
			continuationStrategy: "instruction",
			continuationInstruction: intent.instruction,
			continuationPrefillSuffix: null,
		}
		: {
			continuationStrategy: "assistant-prefill",
			continuationInstruction: null,
			continuationPrefillSuffix: intent.suffix,
		};
};

// ==[HUMAN APPROVED]== The Effective Generation Settings for one attempt. The literal is
// compile-locked to the canonical vocabulary: adding a canonical field fails
// typecheck until the compiler states how it participates.
export const effectiveGenerationSettingsFor = (
	settings: CanonicalGenerationSettings,
	intent: GenerationIntent | undefined,
	connection: GenerationConnectionFacts | null,
): EffectiveGenerationSettings => ({
	modelId: settings.modelId,
	temperature: settings.temperature,
	topP: settings.topP,
	frequencyPenalty: settings.frequencyPenalty,
	presencePenalty: settings.presencePenalty,
	contextLimit: settings.contextLimit,
	responseBudget: settings.responseBudget,
	safetyAllowance: settings.safetyAllowance,
	// ==[HUMAN APPROVED]== No production policy currently consumes this configured limit, and the
	// Model Client projection excludes it. It therefore did not participate in
	// this attempt and must not appear as an effective value.
	siblingGenerationLimit: null,
	...continuationOperands(intent),
	// ==[HUMAN APPROVED]== Only the namespace matching the selected Connection Profile's format is
	// merged into a request; the other namespaces stay editable and are never
	// transmitted. Without a selected Profile no namespace applies.
	requestOverrides: connection === null
		? {}
		: settings.requestOverrides[connection.apiFormat],
});

/**
 * ==[HUMAN APPROVED]== Compiles the complete Generation Plan for one attempt from captured
 * inputs. The returned plan always describes a real budget candidate — a
 * plan that cannot fit carries its failure inside the budget decision
 * instead of throwing, so read-only inspection can report it.
 */
export const compileGenerationPlan = (
	input: CompileGenerationPlanInput,
): GenerationPlan => {
	const intent = input.intent;
	const attempt = input.attempt ?? {
		environment: { self: input.human.name, other: input.model.name },
		state: createMacroAttemptState(),
	};
	// ==[HUMAN APPROVED]== Every budget candidate recompiles through the internal Prompt Compiler
	// with the attempt's intent attached, so an omitted-history candidate
	// keeps describing the same Generation.
	const compile = (context: readonly PromptContextEntry[]): PromptPlan => {
		const compiled = compilePrompt({
			human: input.human,
			model: input.model,
			context,
			recipe: input.recipe,
			attempt,
		});
		return intent === undefined ? compiled : { ...compiled, intent };
	};
	// ==[HUMAN APPROVED]== Intent applicability decides the protected history: an assistant-prefill
	// Continuation must retain the prefixed model text it continues from;
	// every other intent protects the latest human entry by default. A prefill
	// intent without preceding model history has no prefix to continue from,
	// so the compilation fails clearly instead of misreporting a budget index.
	const protectedHistoryIndex = intent?.type === "continuation" &&
			intent.strategy === "assistant-prefill"
		? input.context.length - 1
		: undefined;
	if (protectedHistoryIndex !== undefined && protectedHistoryIndex < 0) {
		throw new Error(
			"An assistant-prefill Continuation requires preceding model history to prefill from.",
		);
	}
	const budget = budgetPromptPlan({
		plan: compile(input.context),
		compile,
		context: input.context,
		contextLimit: input.settings.contextLimit,
		responseBudget: input.settings.responseBudget,
		safetyAllowance: input.settings.safetyAllowance,
		estimator: input.estimator,
		protectedHistoryIndex,
	});
	return {
		promptPlan: budget.plan,
		budget,
		effectiveSettings: effectiveGenerationSettingsFor(
			input.settings,
			intent,
			input.connection,
		),
	};
};

/**
 * ==[HUMAN APPROVED]== Enforces the budget decision before an attempt executes. Inspection
 * compiles without this assertion to report impossible budgets; generation
 * workflows call it so an over-budget plan never contacts a Model Client.
 */
export const assertGenerationPlan = (plan: GenerationPlan): GenerationPlan => {
	if (!plan.budget.fits) throw new PromptBudgetExceededError(plan.budget);
	return plan;
};
