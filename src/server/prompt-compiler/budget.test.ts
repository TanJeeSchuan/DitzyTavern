import { describe, expect, test } from "bun:test";
import type { PromptPlan } from ".";
import {
	PromptBudgetExceededError,
	budgetPromptPlan,
	createTokenEstimator,
	toEstimationTranscript,
} from "./budget";

const planFor = (history: readonly { speakerName: string | null; content: string }[]): PromptPlan => ({
	blocks: [
		{ kind: "system-instruction", content: "Fixed system prompt." },
		...history.map((entry) => ({ kind: "history" as const, ...entry })),
		{ kind: "post-history-instruction", content: "Fixed post-history prompt." },
	],
	warnings: [],
});

describe("Prompt Plan budget", () => {
	test("counts one deterministic transcript for the complete candidate", () => {
		const calls: string[] = [];
		const estimator = createTokenEstimator((transcript) => {
			calls.push(transcript);
			return 3;
		});
		const history = [
			{ speakerName: "Writer", content: "A human line." },
			{ speakerName: "Maren", content: "A model line." },
		];

		const result = budgetPromptPlan({
			plan: planFor(history),
			history,
			historyRoles: ["human", "model"],
			compile: (nextHistory) => planFor(nextHistory),
			contextLimit: 32,
			responseBudget: 8,
			safetyAllowance: 2,
			estimator,
		});

		expect(calls).toEqual([toEstimationTranscript(planFor(history))]);
		expect(result).toMatchObject({
			fits: true,
			tokenEstimate: 3,
			responseBudget: 8,
			safetyAllowance: 2,
			totalRequiredTokens: 13,
			omittedHistory: [],
			retainedHistory: history,
			retainedHistoryRoles: ["human", "model"],
		});
	});

	test("drops the oldest whole history entry and recompiles until it fits", () => {
		const estimates = [200, 100];
		const estimator = createTokenEstimator(() => estimates.shift() ?? 100);
		const history = [
			{ speakerName: "Old", content: "old history" },
			{ speakerName: "Writer", content: "latest human input" },
		];
		const result = budgetPromptPlan({
			plan: planFor(history),
			history,
			historyRoles: ["model", "human"],
			compile: (nextHistory) => planFor(nextHistory),
			contextLimit: 120,
			responseBudget: 1,
			safetyAllowance: 1,
			estimator,
		});

		expect(result.fits).toBe(true);
		expect(result.omittedHistory).toEqual([history[0]]);
		expect(result.retainedHistory).toEqual([history[1]]);
		expect(result.plan.blocks.filter((block) => block.kind === "history")).toEqual([
			{ kind: "history", speakerName: "Writer", content: "latest human input" },
		]);
	});

	test("protects the latest human entry and reports an inspectable failure", () => {
		const estimator = createTokenEstimator(() => 20);
		const history = [{ speakerName: "Writer", content: "protected input" }];
		const result = budgetPromptPlan({
			plan: planFor(history),
			history,
			historyRoles: ["human"],
			compile: (nextHistory) => planFor(nextHistory),
			contextLimit: 30,
			responseBudget: 7,
			safetyAllowance: 5,
			estimator,
		});

		expect(result.fits).toBe(false);
		expect(result.failure?.reason).toBe("protected-history-too-large");
		expect(result.failure?.breakdown).toMatchObject({
			tokenEstimate: 20,
			responseBudget: 7,
			safetyAllowance: 5,
			contextLimit: 30,
			totalRequiredTokens: 32,
		});
		expect(() => {
			throw new PromptBudgetExceededError(result);
		}).toThrow("Prompt Plan exceeds the Conversation context limit");
	});

	test("finds the oldest-first history cutoff with logarithmic estimator work", () => {
		const history = Array.from({ length: 1_024 }, (_, index) => ({
			speakerName: index % 2 === 0 ? "Writer" : "Maren",
			content: `History ${index}`,
		}));
		let estimateCalls = 0;
		const estimator = createTokenEstimator((transcript) => {
			estimateCalls += 1;
			const historyBlocks = transcript.split("\u001fhistory").length - 1;
			return historyBlocks * 10;
		});

		const result = budgetPromptPlan({
			plan: planFor(history),
			history,
			historyRoles: history.map((_, index) => index === history.length - 1 ? "human" : "model"),
			compile: (nextHistory) => planFor(nextHistory),
			contextLimit: 81,
			responseBudget: 1,
			safetyAllowance: 0,
			estimator,
		});

		expect(result.retainedHistory).toHaveLength(8);
		expect(result.retainedHistory[0]).toBe(history[1_016]);
		expect(result.retainedHistory.at(-1)).toBe(history.at(-1));
		expect(estimateCalls).toBeLessThanOrEqual(12);
	});
});
