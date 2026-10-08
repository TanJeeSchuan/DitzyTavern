import { estimateTokenCount } from "tokenx";
import { projectImageAnchors } from "../../shared/image-reference";
import { sentImageTokens } from "./images";
import type { PromptContextEntry, PromptPlan } from "./types";

// @approved
//  The application owns this small synchronous boundary. The heuristic library
// can be replaced without changing Prompt Compiler or Generation code.
export type TokenEstimator = (transcript: string) => number;

// @approved
//  tokenx is deliberately imported in one place. Its estimate is an
// approximation for preflight, never a provider tokenization guarantee.
export const tokenxEstimator: TokenEstimator = estimateTokenCount;

export interface PromptBudgetBreakdown {
	contextLimit: number;
	responseBudget: number;
	safetyAllowance: number;
	tokenEstimate: number;
	totalRequiredTokens: number;
	// @approved
	//  These character counts make an impossible candidate's fixed and
	// protected portions inspectable without making extra estimator calls.
	fixedPromptCharacters: number;
	protectedHistoryCharacters: number;
}

export interface PromptBudgetFailure {
	reason: "fixed-prompt-too-large" | "protected-history-too-large";
	breakdown: PromptBudgetBreakdown;
}

export interface PromptBudgetInput {
	// @approved
	//  `plan` is the first candidate. The callback recompiles the same
	// provider-neutral plan after each whole-history omission.
	plan: PromptPlan;
	compile: (context: readonly PromptContextEntry[]) => PromptPlan;
	context: readonly PromptContextEntry[];
	contextLimit: number;
	responseBudget: number;
	safetyAllowance: number;
	estimator?: TokenEstimator;
	// @approved
	//  When omitted, the latest human entry is protected. Callers may pass the
	// candidate human Message's original index explicitly.
	protectedHistoryIndex?: number | undefined;
}

export interface PromptBudgetResult extends PromptBudgetMeasurement {
	readonly plan: PromptPlan;
	readonly retainedContext: readonly PromptContextEntry[];
	readonly omittedContext: readonly PromptContextEntry[];
}

export interface PromptBudgetMeasurementInput {
	plan: PromptPlan;
	contextLimit: number;
	responseBudget: number;
	safetyAllowance: number;
	estimator?: TokenEstimator;
	// @approved
	//  The failure reason distinguishes an over-large protected history
	// from an otherwise fixed prompt that cannot fit.
	protectedHistory?: boolean;
	protectedHistoryCharacters?: number;
}

export interface PromptBudgetMeasurement {
	readonly fits: boolean;
	readonly tokenEstimate: number;
	readonly responseBudget: number;
	readonly safetyAllowance: number;
	readonly contextLimit: number;
	readonly totalRequiredTokens: number;
	readonly breakdown: PromptBudgetBreakdown;
	readonly failure: PromptBudgetFailure | null;
}

/** @approved
 *
 * Creates the one text representation that token estimation is allowed to
 * count. Block, role, and content separators are fixed by this versioned
 * format so equivalent Prompt Plans produce equivalent estimates.
 */
export function toEstimationTranscript(plan: PromptPlan): string {
	const blocks = plan.blocks.map((block, index) => {
		// @approved
		//  Definition blocks carry the outgoing role their recipe slot chose;
		// history blocks carry no presentation role of their own, only a
		// speaker name.
		const role = block.kind === "history" ? "none" : block.role;
		const speaker = block.kind === "history" ? block.speakerName ?? "none" : "none";
		return [
			`\u001eBLOCK\u001f${index}\u001f${block.kind}`,
			`\u001eROLE\u001f${role}`,
			`\u001eSPEAKER\u001f${speaker}`,
			"\u001eCONTENT\u001f",
			block.content,
		].join("\n");
	});
	const intent = plan.intent === undefined
		? []
		: plan.intent.type === "sibling"
			? ["\u001eINTENT\u001fsibling"]
		: plan.intent.strategy === "instruction"
			? [
					"\u001eINTENT\u001fcontinuation",
					"\u001eSTRATEGY\u001finstruction",
					"\u001eINSTRUCTION\u001f",
					plan.intent.instruction,
				]
			: [
					"\u001eINTENT\u001fcontinuation",
					"\u001eSTRATEGY\u001fassistant-prefill",
					"\u001eSUFFIX\u001f",
					plan.intent.suffix,
				];
	return projectImageAnchors(["ditzytavern-estimation-transcript-v2", ...blocks, ...intent].join("\n"));
}

export function budgetPromptPlan(input: PromptBudgetInput): PromptBudgetResult {
	validateBudgetFields(input.contextLimit, input.responseBudget, input.safetyAllowance);

	const protectedHistoryIndex = input.protectedHistoryIndex ?? findLatestHumanIndex(input.context);
	if (
		protectedHistoryIndex !== undefined &&
		(protectedHistoryIndex < 0 || protectedHistoryIndex >= input.context.length)
	) {
		throw new Error("The protected Prompt history index is outside the candidate history.");
	}

	const estimator = input.estimator ?? tokenxEstimator;
	const allIndexes = input.context.map((_, index) => index);
	const removableIndexes = allIndexes.filter((index) => index !== protectedHistoryIndex);
	const candidateAfterRemoving = (count: number) => {
		const removed = new Set(removableIndexes.slice(0, count));
		const retainedIndexes = allIndexes.filter((index) => !removed.has(index));
		const plan = count === 0
			? input.plan
			: input.compile(retainedIndexes.map((index) => input.context[index]));
		return {
			retainedIndexes,
			plan,
			measurement: measurePromptPlan({
				plan,
				contextLimit: input.contextLimit,
				responseBudget: input.responseBudget,
				safetyAllowance: input.safetyAllowance,
				estimator,
				protectedHistory: protectedHistoryIndex !== undefined,
				protectedHistoryCharacters: protectedHistoryIndex === undefined
					? 0
					: input.context[protectedHistoryIndex]?.content.length ?? 0,
			}),
		};
	};
	let candidate = candidateAfterRemoving(0);

	if (!candidate.measurement.fits && removableIndexes.length > 0) {
		// @approved
		//  Removing oldest whole history blocks only shortens this compiler's
		// estimation transcript. Find the smallest fitting removal count without
		// rebuilding and rescanning a multi-megabyte prompt once per Message.
		let lower = 1;
		let upper = removableIndexes.length;
		let fitting: ReturnType<typeof candidateAfterRemoving> | undefined;
		while (lower <= upper) {
			const middle = Math.floor((lower + upper) / 2);
			const inspected = candidateAfterRemoving(middle);
			if (inspected.measurement.fits) {
				fitting = inspected;
				upper = middle - 1;
			} else {
				lower = middle + 1;
			}
		}
		candidate = fitting ?? candidateAfterRemoving(removableIndexes.length);
	}

	const { retainedIndexes, plan, measurement } = candidate;
	return createResult({
		input,
		plan,
		retainedIndexes,
		measurement,
	});
}

/** @approved
 * Validate an already-expanded plan without recompiling it or trimming its
 * history. An inspected plan is the user's direct model input, so accepting
 * it must preserve every edit and report an over-ceiling plan as-is.
 */
export function budgetEditedPromptPlan(input: {
	plan: PromptPlan;
	contextLimit: number;
	responseBudget: number;
	safetyAllowance: number;
	estimator?: TokenEstimator;
}): PromptBudgetResult {
	const measurement = measurePromptPlan({
		plan: input.plan,
		contextLimit: input.contextLimit,
		responseBudget: input.responseBudget,
		safetyAllowance: input.safetyAllowance,
		estimator: input.estimator,
	});
	return {
		fits: measurement.fits,
		plan: input.plan,
		retainedContext: [],
		omittedContext: [],
		tokenEstimate: measurement.tokenEstimate,
		responseBudget: measurement.responseBudget,
		safetyAllowance: measurement.safetyAllowance,
		contextLimit: measurement.contextLimit,
		totalRequiredTokens: measurement.totalRequiredTokens,
		breakdown: measurement.breakdown,
		failure: measurement.failure,
	};
}

/** @approved
 * Measures one ordered Prompt Plan. Both the trimming
 * path and the inspected path use this step, so their token estimate,
 * breakdown, and fit decision cannot drift apart.
 */
export function measurePromptPlan(input: PromptBudgetMeasurementInput): PromptBudgetMeasurement {
	validateBudgetFields(input.contextLimit, input.responseBudget, input.safetyAllowance);
	const tokenEstimate = estimateCandidate(input.estimator ?? tokenxEstimator, input.plan);
	const breakdown = createBreakdown({
		contextLimit: input.contextLimit,
		responseBudget: input.responseBudget,
		safetyAllowance: input.safetyAllowance,
		protectedHistoryCharacters: input.protectedHistoryCharacters ?? 0,
	}, input.plan, tokenEstimate);
	const fits = breakdown.totalRequiredTokens <= input.contextLimit;
	return {
		fits,
		tokenEstimate,
		responseBudget: input.responseBudget,
		safetyAllowance: input.safetyAllowance,
		contextLimit: input.contextLimit,
		totalRequiredTokens: breakdown.totalRequiredTokens,
		breakdown,
		failure: fits
			? null
			: {
				reason: input.protectedHistory === true
					? "protected-history-too-large"
					: "fixed-prompt-too-large",
				breakdown,
			},
	};
}

const validateBudgetFields = (
	contextLimit: number,
	responseBudget: number,
	safetyAllowance: number,
): void => {
	if (!Number.isInteger(contextLimit) || contextLimit <= 0) {
		throw new Error("Prompt context limit must be a positive whole number.");
	}
	if (!Number.isInteger(responseBudget) || responseBudget <= 0) {
		throw new Error("Prompt response budget must be a positive whole number.");
	}
	if (!Number.isInteger(safetyAllowance) || safetyAllowance < 0) {
		throw new Error("Prompt Safety allowance must be a non-negative whole number.");
	}
};

export class PromptBudgetExceededError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };

	readonly result: PromptBudgetResult;
	readonly breakdown: PromptBudgetBreakdown;

	constructor(result: PromptBudgetResult) {
		super("Prompt Plan exceeds the Conversation context limit.");
		this.name = "PromptBudgetExceededError";
		this.result = result;
		this.breakdown = result.breakdown;
	}
}

function findLatestHumanIndex(
	context: readonly PromptContextEntry[],
): number | undefined {
	for (let index = context.length - 1; index >= 0; index -= 1) {
		if (context[index]?.role === "human") return index;
	}
	return undefined;
}

function estimateCandidate(estimator: TokenEstimator, plan: PromptPlan): number {
	const estimate = estimator(toEstimationTranscript(plan));
	if (!Number.isFinite(estimate) || estimate < 0) {
		throw new Error("The Prompt Token Estimator returned an invalid estimate.");
	}
	return Math.ceil(estimate) + sentImageTokens(plan.images);
}

function createBreakdown(
	input: Pick<PromptBudgetInput, "contextLimit" | "responseBudget" | "safetyAllowance"> & {
		protectedHistoryCharacters: number;
	},
	plan: PromptPlan,
	tokenEstimate: number,
): PromptBudgetBreakdown {
	const fixedPromptCharacters = plan.blocks
		.filter((block) => block.kind !== "history")
		.reduce((total, block) => total + block.content.length, 0) +
		(plan.intent === undefined
			? 0
		: plan.intent.type === "sibling"
				? 0
				: plan.intent.strategy === "instruction"
					? plan.intent.instruction.length
					: plan.intent.suffix.length);
	return {
		contextLimit: input.contextLimit,
		responseBudget: input.responseBudget,
		safetyAllowance: input.safetyAllowance,
		tokenEstimate,
		totalRequiredTokens: tokenEstimate + input.responseBudget + input.safetyAllowance,
		fixedPromptCharacters,
		protectedHistoryCharacters: input.protectedHistoryCharacters,
	};
}

function createResult(input: {
	input: PromptBudgetInput;
	plan: PromptPlan;
	retainedIndexes: readonly number[];
	measurement: PromptBudgetMeasurement;
}): PromptBudgetResult {
	const retainedSet = new Set(input.retainedIndexes);
	return {
		fits: input.measurement.fits,
		plan: input.plan,
		retainedContext: input.retainedIndexes.map((index) => input.input.context[index]),
		omittedContext: input.input.context.filter((_, index) => !retainedSet.has(index)),
		tokenEstimate: input.measurement.tokenEstimate,
		responseBudget: input.input.responseBudget,
		safetyAllowance: input.input.safetyAllowance,
		contextLimit: input.input.contextLimit,
		totalRequiredTokens: input.measurement.totalRequiredTokens,
		breakdown: input.measurement.breakdown,
		failure: input.measurement.failure,
	};
}
