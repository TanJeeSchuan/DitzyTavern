import { estimateTokenCount } from "tokenx";
import type { PromptContextEntry, PromptPlan } from "./types";

// ==[HUMAN APPROVED]== The application owns this small synchronous boundary. The heuristic library
// can be replaced without changing Prompt Compiler or Generation code.
export type TokenEstimator = (transcript: string) => number;

// ==[HUMAN APPROVED]== tokenx is deliberately imported in one place. Its estimate is an
// approximation for preflight, never a provider tokenization guarantee.
export const tokenxEstimator: TokenEstimator = estimateTokenCount;

export interface PromptBudgetBreakdown {
	contextLimit: number;
	responseBudget: number;
	safetyAllowance: number;
	tokenEstimate: number;
	totalRequiredTokens: number;
	// ==[HUMAN APPROVED]== These character counts make an impossible candidate's fixed and
	// protected portions inspectable without making extra estimator calls.
	fixedPromptCharacters: number;
	protectedHistoryCharacters: number;
}

export interface PromptBudgetFailure {
	reason: "fixed-prompt-too-large" | "protected-history-too-large";
	breakdown: PromptBudgetBreakdown;
}

export interface PromptBudgetInput {
	// ==[HUMAN APPROVED]== `plan` is the first candidate. The callback recompiles the same
	// provider-neutral plan after each whole-history omission.
	plan: PromptPlan;
	compile: (context: readonly PromptContextEntry[]) => PromptPlan;
	context: readonly PromptContextEntry[];
	contextLimit: number;
	responseBudget: number;
	safetyAllowance: number;
	estimator?: TokenEstimator;
	// ==[HUMAN APPROVED]== When omitted, the latest human entry is protected. Callers may pass the
	// candidate human Message's original index explicitly.
	protectedHistoryIndex?: number | undefined;
}

export interface PromptBudgetResult {
	readonly fits: boolean;
	readonly plan: PromptPlan;
	readonly retainedContext: readonly PromptContextEntry[];
	readonly omittedContext: readonly PromptContextEntry[];
	readonly tokenEstimate: number;
	readonly responseBudget: number;
	readonly safetyAllowance: number;
	readonly contextLimit: number;
	readonly totalRequiredTokens: number;
	readonly breakdown: PromptBudgetBreakdown;
	readonly failure: PromptBudgetFailure | null;
}

/**
 * ==[HUMAN APPROVED]==
 * Creates the one text representation that token estimation is allowed to
 * count. Block, role, and content separators are fixed by this versioned
 * format so equivalent Prompt Plans produce equivalent estimates.
 */
export function toEstimationTranscript(plan: PromptPlan): string {
	const blocks = plan.blocks.map((block, index) => {
		// ==[HUMAN APPROVED]== Definition blocks carry the outgoing role their recipe slot chose;
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
	return ["ditzytavern-estimation-transcript-v2", ...blocks, ...intent].join("\n");
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
		return { retainedIndexes, plan, tokenEstimate: estimateCandidate(estimator, plan) };
	};
	const fits = (tokenEstimate: number) =>
		tokenEstimate + input.responseBudget + input.safetyAllowance <= input.contextLimit;
	let candidate = candidateAfterRemoving(0);

	if (!fits(candidate.tokenEstimate) && removableIndexes.length > 0) {
		// ==[HUMAN APPROVED]== Removing oldest whole history blocks only shortens this compiler's
		// estimation transcript. Find the smallest fitting removal count without
		// rebuilding and rescanning a multi-megabyte prompt once per Message.
		let lower = 1;
		let upper = removableIndexes.length;
		let fitting: ReturnType<typeof candidateAfterRemoving> | undefined;
		while (lower <= upper) {
			const middle = Math.floor((lower + upper) / 2);
			const inspected = candidateAfterRemoving(middle);
			if (fits(inspected.tokenEstimate)) {
				fitting = inspected;
				upper = middle - 1;
			} else {
				lower = middle + 1;
			}
		}
		candidate = fitting ?? candidateAfterRemoving(removableIndexes.length);
	}

	const { retainedIndexes, plan, tokenEstimate } = candidate;
	if (!fits(tokenEstimate)) {
		const breakdown = createBreakdown(input, plan, tokenEstimate, protectedHistoryIndex);
		return createResult({
			input,
			plan,
			retainedIndexes,
			tokenEstimate,
			breakdown,
			failure: {
				reason: protectedHistoryIndex === undefined
					? "fixed-prompt-too-large"
					: "protected-history-too-large",
				breakdown,
			},
		});
	}

	const breakdown = createBreakdown(input, plan, tokenEstimate, protectedHistoryIndex);
	return createResult({
		input,
		plan,
		retainedIndexes,
		tokenEstimate,
		breakdown,
		failure: null,
	});
}

/**
 * ==[HUMAN APPROVED]== Validate an already-expanded plan without recompiling it or trimming its
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
	validateBudgetFields(input.contextLimit, input.responseBudget, input.safetyAllowance);
	const tokenEstimate = Math.ceil((input.estimator ?? tokenxEstimator)(toEstimationTranscript(input.plan)));
	if (!Number.isFinite(tokenEstimate) || tokenEstimate < 0) {
		throw new Error("The Prompt Token Estimator returned an invalid estimate.");
	}
	const breakdown: PromptBudgetBreakdown = {
		contextLimit: input.contextLimit,
		responseBudget: input.responseBudget,
		safetyAllowance: input.safetyAllowance,
		tokenEstimate,
		totalRequiredTokens: tokenEstimate + input.responseBudget + input.safetyAllowance,
		fixedPromptCharacters: input.plan.blocks
			.filter((block) => block.kind !== "history")
			.reduce((total, block) => total + block.content.length, 0),
		protectedHistoryCharacters: 0,
	};
	const fits = breakdown.totalRequiredTokens <= input.contextLimit;
	return {
		fits,
		plan: input.plan,
		retainedContext: [],
		omittedContext: [],
		tokenEstimate,
		responseBudget: input.responseBudget,
		safetyAllowance: input.safetyAllowance,
		contextLimit: input.contextLimit,
		totalRequiredTokens: breakdown.totalRequiredTokens,
		breakdown,
		failure: fits
			? null
			: { reason: "fixed-prompt-too-large", breakdown },
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
	return Math.ceil(estimate);
}

function createBreakdown(
	input: PromptBudgetInput,
	plan: PromptPlan,
	tokenEstimate: number,
	protectedHistoryIndex: number | undefined,
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
	const protectedHistoryCharacters = protectedHistoryIndex === undefined
		? 0
		: input.context[protectedHistoryIndex]?.content.length ?? 0;
	return {
		contextLimit: input.contextLimit,
		responseBudget: input.responseBudget,
		safetyAllowance: input.safetyAllowance,
		tokenEstimate,
		totalRequiredTokens: tokenEstimate + input.responseBudget + input.safetyAllowance,
		fixedPromptCharacters,
		protectedHistoryCharacters,
	};
}

function createResult(input: {
	input: PromptBudgetInput;
	plan: PromptPlan;
	retainedIndexes: readonly number[];
	tokenEstimate: number;
	breakdown: PromptBudgetBreakdown;
	failure: PromptBudgetFailure | null;
}): PromptBudgetResult {
	const retainedSet = new Set(input.retainedIndexes);
	return {
		fits: input.failure === null,
		plan: input.plan,
		retainedContext: input.retainedIndexes.map((index) => input.input.context[index]),
		omittedContext: input.input.context.filter((_, index) => !retainedSet.has(index)),
		tokenEstimate: input.tokenEstimate,
		responseBudget: input.input.responseBudget,
		safetyAllowance: input.input.safetyAllowance,
		contextLimit: input.input.contextLimit,
		totalRequiredTokens: input.breakdown.totalRequiredTokens,
		breakdown: input.breakdown,
		failure: input.failure,
	};
}
