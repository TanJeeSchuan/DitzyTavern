import { estimateTokenCount } from "tokenx";
import type { PromptHistoryEntry, PromptPlan } from "./types";

// The application owns this small synchronous boundary. The heuristic library
// can be replaced without changing Prompt Compiler or Generation code.
export interface TokenEstimator {
	estimate(transcript: string): number;
}

export function createTokenEstimator(
	estimate: (transcript: string) => number,
): TokenEstimator {
	return { estimate };
}

// tokenx is deliberately imported in one place. Its estimate is an
// approximation for preflight, never a provider tokenization guarantee.
export const tokenxEstimator: TokenEstimator = createTokenEstimator(
	(transcript) => estimateTokenCount(transcript),
);

export type PromptHistoryRole = "human" | "model" | null;

export interface PromptBudgetBreakdown {
	contextLimit: number;
	responseBudget: number;
	safetyAllowance: number;
	tokenEstimate: number;
	totalRequiredTokens: number;
	// These character counts make an impossible candidate's fixed and
	// protected portions inspectable without making extra estimator calls.
	fixedPromptCharacters: number;
	protectedHistoryCharacters: number;
}

export interface PromptBudgetFailure {
	reason: "fixed-prompt-too-large" | "protected-history-too-large";
	breakdown: PromptBudgetBreakdown;
}

export interface PromptBudgetInput {
	// `plan` is the first candidate. The callback recompiles the same
	// provider-neutral plan after each whole-history omission.
	plan: PromptPlan;
	compile: (history: readonly PromptHistoryEntry[]) => PromptPlan;
	history: readonly PromptHistoryEntry[];
	historyRoles: readonly PromptHistoryRole[];
	contextLimit: number;
	responseBudget: number;
	safetyAllowance: number;
	estimator?: TokenEstimator;
	// When omitted, the latest human history entry is protected. Ticket 03 can
	// pass the candidate human Message's original index explicitly.
	protectedHistoryIndex?: number | undefined;
}

export interface PromptBudgetResult {
	readonly fits: boolean;
	readonly plan: PromptPlan;
	readonly retainedHistory: readonly PromptHistoryEntry[];
	readonly retainedHistoryRoles: readonly PromptHistoryRole[];
	readonly omittedHistory: readonly PromptHistoryEntry[];
	readonly tokenEstimate: number;
	readonly responseBudget: number;
	readonly safetyAllowance: number;
	readonly contextLimit: number;
	readonly totalRequiredTokens: number;
	readonly breakdown: PromptBudgetBreakdown;
	readonly failure: PromptBudgetFailure | null;
}

/**
 * Creates the one text representation that token estimation is allowed to
 * count. Block, role, and content separators are fixed by this versioned
 * format so equivalent Prompt Plans produce equivalent estimates.
 */
export function toEstimationTranscript(plan: PromptPlan): string {
	const blocks = plan.blocks.map((block, index) => {
		const role = block.kind === "identity" ? block.role : "none";
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
	return ["ditzytavern-estimation-transcript-v1", ...blocks, ...intent].join("\n");
}

export function budgetPromptPlan(input: PromptBudgetInput): PromptBudgetResult {
	if (input.historyRoles.length !== input.history.length) {
		throw new Error("Prompt history roles must align with Prompt history entries.");
	}
	if (!Number.isInteger(input.contextLimit) || input.contextLimit <= 0) {
		throw new Error("Prompt context limit must be a positive whole number.");
	}
	if (!Number.isInteger(input.responseBudget) || input.responseBudget <= 0) {
		throw new Error("Prompt response budget must be a positive whole number.");
	}
	if (!Number.isInteger(input.safetyAllowance) || input.safetyAllowance < 0) {
		throw new Error("Prompt Safety allowance must be a non-negative whole number.");
	}

	const protectedHistoryIndex = input.protectedHistoryIndex ?? findLatestHumanIndex(input.historyRoles);
	if (
		protectedHistoryIndex !== undefined &&
		(protectedHistoryIndex < 0 || protectedHistoryIndex >= input.history.length)
	) {
		throw new Error("The protected Prompt history index is outside the candidate history.");
	}

	const estimator = input.estimator ?? tokenxEstimator;
	let retainedIndexes = input.history.map((_, index) => index);
	let plan = input.plan;
	let tokenEstimate = estimateCandidate(estimator, plan);

	while (tokenEstimate + input.responseBudget + input.safetyAllowance > input.contextLimit) {
		const removableIndex = retainedIndexes.find(
			(index) => index !== protectedHistoryIndex,
		);
		if (removableIndex === undefined) {
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

		retainedIndexes = retainedIndexes.filter((index) => index !== removableIndex);
		plan = input.compile(retainedIndexes.map((index) => input.history[index]));
		tokenEstimate = estimateCandidate(estimator, plan);
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

export function assertPromptBudget(result: PromptBudgetResult): PromptBudgetResult {
	if (!result.fits) throw new PromptBudgetExceededError(result);
	return result;
}

function findLatestHumanIndex(
	roles: readonly PromptHistoryRole[],
): number | undefined {
	for (let index = roles.length - 1; index >= 0; index -= 1) {
		if (roles[index] === "human") return index;
	}
	return undefined;
}

function estimateCandidate(estimator: TokenEstimator, plan: PromptPlan): number {
	const estimate = estimator.estimate(toEstimationTranscript(plan));
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
		: input.history[protectedHistoryIndex]?.content.length ?? 0;
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
		retainedHistory: input.retainedIndexes.map((index) => input.input.history[index]),
		retainedHistoryRoles: input.retainedIndexes.map((index) => input.input.historyRoles[index]),
		omittedHistory: input.input.history.filter((_, index) => !retainedSet.has(index)),
		tokenEstimate: input.tokenEstimate,
		responseBudget: input.input.responseBudget,
		safetyAllowance: input.input.safetyAllowance,
		contextLimit: input.input.contextLimit,
		totalRequiredTokens: input.breakdown.totalRequiredTokens,
		breakdown: input.breakdown,
		failure: input.failure,
	};
}
