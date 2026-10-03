import { describe, expect, test } from "bun:test";
import type { PromptContextEntry, PromptPlan } from ".";
import {
	budgetPromptPlan,
	budgetEditedPromptPlan,
	toEstimationTranscript,
} from "./budget";

// Each entry carries its own role, so a compiled block is the entry itself
// rather than an entry paired with a role from somewhere else.
const entry = (
	speakerName: string | null,
	content: string,
	role: PromptContextEntry["role"],
): PromptContextEntry => ({ kind: "message", speakerName, content, role });

const planFor = (context: readonly PromptContextEntry[]): PromptPlan => ({
	blocks: [
		{ kind: "system-instruction", role: "system", content: "Fixed system prompt." },
		...context.map(({ kind: _kind, ...rest }) => ({ kind: "history" as const, ...rest })),
		{ kind: "post-history-instruction", role: "system", content: "Fixed post-history prompt." },
	],
	warnings: [],
});

describe("Prompt Plan budget", () => {
	test("counts one deterministic transcript for the complete candidate", () => {
		const calls: string[] = [];
		const estimator = (transcript: string) => {
			calls.push(transcript);
			return 3;
		};
		const history = [
			entry("Writer", "A human line.", "human"),
			entry("Maren", "A model line.", "model"),
		];

		const result = budgetPromptPlan({
			plan: planFor(history),
			context: history,
			compile: (nextContext) => planFor(nextContext),
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
			omittedContext: [],
			retainedContext: history,
		});
	});

	test("drops the oldest whole history entry and recompiles until it fits", () => {
		const estimates = [200, 100];
		const estimator = () => estimates.shift() ?? 100;
		const history = [
			entry("Old", "old history", "model"),
			entry("Writer", "latest human input", "human"),
		];
		const result = budgetPromptPlan({
			plan: planFor(history),
			context: history,
			compile: (nextContext) => planFor(nextContext),
			contextLimit: 120,
			responseBudget: 1,
			safetyAllowance: 1,
			estimator,
		});

		expect(result.fits).toBe(true);
		expect(result.omittedContext).toEqual([history[0]]);
		expect(result.retainedContext).toEqual([history[1]]);
		expect(result.plan.blocks.filter((block) => block.kind === "history")).toEqual([
			{ kind: "history", speakerName: "Writer", content: "latest human input", role: "human" },
		]);
	});

	test("protects the latest human entry and reports an inspectable failure", () => {
		const estimator = () => 20;
		const history = [entry("Writer", "protected input", "human")];
		const result = budgetPromptPlan({
			plan: planFor(history),
			context: history,
			compile: (nextContext) => planFor(nextContext),
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
	});

	test("finds the oldest-first history cutoff with logarithmic estimator work", () => {
		const history = Array.from({ length: 1_024 }, (_, index) => entry(
			index % 2 === 0 ? "Writer" : "Maren",
			`History ${index}`,
			index === 1_023 ? "human" : "model",
		));
		let estimateCalls = 0;
		const estimator = (transcript: string) => {
			estimateCalls += 1;
			const historyBlocks = transcript.split("\u001fhistory").length - 1;
			return historyBlocks * 10;
		};

		const result = budgetPromptPlan({
			plan: planFor(history),
			context: history,
			compile: (nextContext) => planFor(nextContext),
			contextLimit: 81,
			responseBudget: 1,
			safetyAllowance: 0,
			estimator,
		});

		expect(result.retainedContext).toHaveLength(8);
		expect(result.retainedContext[0]).toBe(history[1_016]);
		expect(result.retainedContext.at(-1)).toBe(history.at(-1));
		expect(estimateCalls).toBeLessThanOrEqual(12);
	});

	test("uses the same measurement fields for an inspected intent", () => {
		const instruction = "Continue this scene.";
		const plan = {
			...planFor([]),
			intent: { type: "continuation" as const, strategy: "instruction" as const, instruction },
		};
		const result = budgetEditedPromptPlan({
			plan,
			contextLimit: 20,
			responseBudget: 2,
			safetyAllowance: 1,
			estimator: () => 4,
		});

		expect(result.breakdown).toMatchObject({
			tokenEstimate: 4,
			fixedPromptCharacters: "Fixed system prompt.".length + "Fixed post-history prompt.".length + instruction.length,
			totalRequiredTokens: 7,
		});
	});
});
