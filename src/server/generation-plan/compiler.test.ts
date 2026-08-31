import { describe, expect, test } from "bun:test";
import {
	assertGenerationPlan,
	compileGenerationPlan,
	continuationIntentFor,
	type GenerationPlan,
} from ".";
import {
	createTokenEstimator,
	PromptBudgetExceededError,
	type CompilePromptDefinition,
	type PromptHistoryEntry,
} from "../prompt-compiler";
import type { CanonicalGenerationSettings } from "../../shared/contract/generation-settings";

// Deterministic Generation Plan Compiler tests (ADR-0032). Every Generation
// intent, the budget outcomes, the active API Format selection for Request
// Overrides, and the secret exclusion of the compiled plan are exercised
// through the one principal planning interface with fixed inputs.

const human: CompilePromptDefinition = {
	name: "Writer",
	prompt: {
		systemInstruction: "",
		identity: "I am Writer.",
		scenario: "",
		exampleDialogue: "",
		postHistoryInstruction: "",
	},
};

const model: CompilePromptDefinition = {
	name: "Maren",
	prompt: {
		systemInstruction: "Keep the reply literary.",
		identity: "I am Maren.",
		scenario: "",
		exampleDialogue: "",
		postHistoryInstruction: "",
	},
};

const configuredSettings = (
	overrides: Partial<CanonicalGenerationSettings> = {},
): CanonicalGenerationSettings => ({
	modelId: "deepseek-chat",
	temperature: null,
	topP: null,
	frequencyPenalty: null,
	presencePenalty: null,
	contextLimit: 100_000,
	responseBudget: 1024,
	safetyAllowance: 500,
	siblingGenerationLimit: 4,
	continuationStrategy: "instruction",
	continuationInstruction: "Carry the scene forward.",
	continuationPrefillSuffix: "",
	requestOverrides: {
		"chat-completions": { logit_bias: { "50256": -100 } },
		responses: { metadata: { workspace: "responses-only" } },
		"anthropic-messages": { metadata: { workspace: "anthropic-only" } },
	},
	...overrides,
});

const entry = (speakerName: string, content: string): PromptHistoryEntry => ({
	speakerName,
	content,
});

// The transcript length is a monotone stand-in for a tokenizer: a longer
// Prompt Plan estimates higher, so budget outcomes stay deterministic.
const transcriptLengthEstimator = createTokenEstimator(
	(transcript) => transcript.length,
);

const compile = (
	overrides: Partial<Parameters<typeof compileGenerationPlan>[0]> = {},
): GenerationPlan => compileGenerationPlan({
	human,
	model,
	history: [entry("Maren", "The lamp turns above you.")],
	historyRoles: ["model"],
	settings: configuredSettings(),
	connection: { apiFormat: "chat-completions" },
	estimator: transcriptLengthEstimator,
	...overrides,
});

describe("Generation Plan Compiler", () => {
	test("compiles the ordinary Tail plan with no applicable Continuation operand", () => {
		const plan = compile({ intent: undefined });

		expect(plan.promptPlan.blocks.map((block) => block.kind)).toEqual([
			"system-instruction",
			"identity",
			"identity",
			"history",
		]);
		expect(plan.promptPlan.intent).toBeUndefined();
		// Effective settings describe the attempt: the Continuation group is
		// not applicable to a Tail Generation and is absent, not copied.
		expect(plan.effectiveSettings).toEqual({
			modelId: "deepseek-chat",
			temperature: null,
			topP: null,
			frequencyPenalty: null,
			presencePenalty: null,
			contextLimit: 100_000,
			responseBudget: 1024,
			safetyAllowance: 500,
			siblingGenerationLimit: 4,
			continuationStrategy: null,
			continuationInstruction: null,
			continuationPrefillSuffix: null,
			requestOverrides: { logit_bias: { "50256": -100 } },
		});
		expect(plan.budget.fits).toBe(true);
		expect(plan.budget.contextLimit).toBe(100_000);
		expect(plan.budget.responseBudget).toBe(1024);
		expect(plan.budget.safetyAllowance).toBe(500);
	});

	test("compiles the Sibling plan with the sibling intent and no Continuation operand", () => {
		const plan = compile({ intent: { type: "sibling" } });

		expect(plan.promptPlan.intent).toEqual({ type: "sibling" });
		expect(plan.effectiveSettings.continuationStrategy).toBeNull();
		expect(plan.effectiveSettings.continuationInstruction).toBeNull();
		expect(plan.effectiveSettings.continuationPrefillSuffix).toBeNull();
	});

	test("compiles an instruction Continuation retaining only the Continuation instruction", () => {
		const settings = configuredSettings({
			continuationStrategy: "instruction",
			continuationInstruction: "Carry the scene forward.",
			continuationPrefillSuffix: "\n\n",
		});
		const intent = continuationIntentFor(settings);
		const plan = compile({ intent, historyRoles: ["human", "model"], history: [
			entry("Writer", "h".repeat(400)),
			entry("Maren", "m".repeat(400)),
		] });

		expect(plan.promptPlan.intent).toEqual({
			type: "continuation",
			strategy: "instruction",
			instruction: "Carry the scene forward.",
		});
		// The applicable operand is retained; the Prefill suffix is not.
		expect(plan.effectiveSettings.continuationStrategy).toBe("instruction");
		expect(plan.effectiveSettings.continuationInstruction).toBe(
			"Carry the scene forward.",
		);
		expect(plan.effectiveSettings.continuationPrefillSuffix).toBeNull();
	});

	test("compiles an assistant-prefill Continuation retaining only the Prefill suffix", () => {
		const settings = configuredSettings({
			continuationStrategy: "assistant-prefill",
			continuationInstruction: "This instruction is not applicable.",
			continuationPrefillSuffix: "\n",
		});
		const intent = continuationIntentFor(settings);
		const plan = compile({ intent, historyRoles: ["human", "model"], history: [
			entry("Writer", "h".repeat(400)),
			entry("Maren", "p".repeat(400)),
		] });

		expect(plan.promptPlan.intent).toEqual({
			type: "continuation",
			strategy: "assistant-prefill",
			suffix: "\n",
		});
		expect(plan.effectiveSettings.continuationStrategy).toBe("assistant-prefill");
		expect(plan.effectiveSettings.continuationInstruction).toBeNull();
		expect(plan.effectiveSettings.continuationPrefillSuffix).toBe("\n");
	});

	test("selects Request Overrides only from the active API Format", () => {
		const chatCompletions = compile({
			connection: { apiFormat: "chat-completions" },
		});
		const responses = compile({
			connection: { apiFormat: "responses" },
		});
		const anthropicMessages = compile({
			connection: { apiFormat: "anthropic-messages" },
		});

		expect(chatCompletions.effectiveSettings.requestOverrides).toEqual({
			logit_bias: { "50256": -100 },
		});
		expect(responses.effectiveSettings.requestOverrides).toEqual({
			metadata: { workspace: "responses-only" },
		});
		expect(anthropicMessages.effectiveSettings.requestOverrides).toEqual({
			metadata: { workspace: "anthropic-only" },
		});
		// Inactive namespaces never enter the plan at all.
		expect(JSON.stringify(chatCompletions)).not.toContain("responses-only");
		expect(JSON.stringify(chatCompletions)).not.toContain("anthropic-only");
		expect(JSON.stringify(responses)).not.toContain("logit_bias");
		expect(JSON.stringify(anthropicMessages)).not.toContain("logit_bias");
	});

	test("applies no Request Overrides without an active Profile", () => {
		const plan = compile({ connection: null });

		expect(plan.effectiveSettings.requestOverrides).toEqual({});
	});

	test("keeps credentials, headers, and connection URLs out of the compiled plan", () => {
		// The compiler input carries only the safe API Format fact; this test
		// pins the boundary so a future plan field can never start carrying
		// transport identity.
		const plan = compile();

		const serialized = JSON.stringify(plan);
		expect(serialized).not.toContain("https://");
		expect(serialized).not.toContain("Bearer ");
		expect(serialized).not.toContain("authorization");
		expect(serialized).not.toContain("credential");
		expect(serialized).not.toContain("secret");
	});

	test("produces equivalent plans from identical captured inputs", () => {
		const input = {
			human,
			model,
			history: [entry("Maren", "The lamp turns above you.")],
			historyRoles: ["model"] as const,
			intent: continuationIntentFor(configuredSettings()),
			settings: configuredSettings(),
			connection: { apiFormat: "chat-completions" as const },
			estimator: transcriptLengthEstimator,
		};

		expect(compileGenerationPlan(input)).toEqual(compileGenerationPlan({ ...input }));
	});

	test("protects the prefill prefix instead of the latest human entry", () => {
		const settings = configuredSettings({
			contextLimit: 1000,
			responseBudget: 10,
			safetyAllowance: 0,
			continuationStrategy: "assistant-prefill",
			continuationPrefillSuffix: " ",
		});
		const plan = compile({
			settings,
			intent: continuationIntentFor(settings),
			historyRoles: ["human", "model"],
			history: [entry("Writer", "h".repeat(400)), entry("Maren", "p".repeat(400))],
		});

		// The history shrank before the prefix: the human entry was omitted
		// while the prefill prefix stayed protected.
		expect(plan.budget.fits).toBe(true);
		expect(plan.budget.omittedHistory).toEqual([entry("Writer", "h".repeat(400))]);
		expect(plan.promptPlan.blocks.filter((block) => block.kind === "history")).toEqual([
			{ kind: "history", speakerName: "Maren", content: "p".repeat(400) },
		]);
	});

	test("reports an impossible protected prefill prefix as a budget failure", () => {
		const settings = configuredSettings({
			contextLimit: 200,
			responseBudget: 10,
			safetyAllowance: 0,
			continuationStrategy: "assistant-prefill",
			continuationPrefillSuffix: " ",
		});
		const plan = compile({
			settings,
			intent: continuationIntentFor(settings),
			historyRoles: ["human", "model"],
			history: [entry("Writer", "h".repeat(400)), entry("Maren", "p".repeat(400))],
		});

		expect(plan.budget.fits).toBe(false);
		expect(plan.budget.failure?.reason).toBe("protected-history-too-large");
		// The failing candidate still protects the prefill prefix and omits
		// the human entry, so the breakdown describes a real candidate.
		expect(plan.promptPlan.blocks.filter((block) => block.kind === "history")).toEqual([
			{ kind: "history", speakerName: "Maren", content: "p".repeat(400) },
		]);
		expect(plan.budget.omittedHistory).toEqual([entry("Writer", "h".repeat(400))]);
	});

	test("recompiles omitted history with the Continuation intent intact", () => {
		const settings = configuredSettings({
			contextLimit: 1000,
			responseBudget: 10,
			safetyAllowance: 0,
		});
		const plan = compile({
			settings,
			intent: continuationIntentFor(settings),
			historyRoles: ["human", "model"],
			history: [entry("Writer", "h".repeat(400)), entry("Maren", "m".repeat(400))],
		});

		expect(plan.budget.fits).toBe(true);
		// The latest human entry stays protected; the older model entry is the
		// whole-history omission.
		expect(plan.budget.omittedHistory).toEqual([entry("Maren", "m".repeat(400))]);
		expect(plan.promptPlan.intent).toEqual({
			type: "continuation",
			strategy: "instruction",
			instruction: "Carry the scene forward.",
		});
	});

	test("protects the latest human entry of an ordinary Tail plan", () => {
		const plan = compile({
			settings: configuredSettings({
				contextLimit: 1000,
				responseBudget: 10,
				safetyAllowance: 0,
			}),
			historyRoles: ["model", "human"],
			history: [entry("Maren", "m".repeat(400)), entry("Writer", "h".repeat(400))],
		});

		expect(plan.budget.fits).toBe(true);
		expect(plan.budget.omittedHistory).toEqual([entry("Maren", "m".repeat(400))]);
		expect(plan.promptPlan.blocks.filter((block) => block.kind === "history")).toEqual([
			{ kind: "history", speakerName: "Writer", content: "h".repeat(400) },
		]);
	});

	test("fails clearly when an assistant-prefill Continuation has no preceding model history", () => {
		const settings = configuredSettings({
			continuationStrategy: "assistant-prefill",
			continuationPrefillSuffix: " ",
		});
		expect(() => compile({
			intent: continuationIntentFor(settings),
			historyRoles: [],
			history: [],
		})).toThrow(
			"An assistant-prefill Continuation requires preceding model history to prefill from.",
		);
	});

	test("assertGenerationPlan enforces the budget decision for execution", () => {
		const fitting = compile();
		expect(assertGenerationPlan(fitting)).toEqual(fitting);

		const impossible = compile({
			settings: configuredSettings({ contextLimit: 200 }),
			historyRoles: ["human", "model"],
			history: [entry("Writer", "h".repeat(400)), entry("Maren", "m".repeat(400))],
		});
		expect(impossible.budget.fits).toBe(false);
		try {
			assertGenerationPlan(impossible);
			throw new Error("Expected the impossible plan to be rejected.");
		} catch (error) {
			expect(error).toBeInstanceOf(PromptBudgetExceededError);
			if (!(error instanceof PromptBudgetExceededError)) return;
			expect(error.result.failure?.reason).toBe("protected-history-too-large");
			expect(error.breakdown.contextLimit).toBe(200);
		}
	});

	test("derives the continuation intent from the configured strategy alone", () => {
		expect(continuationIntentFor(configuredSettings())).toEqual({
			type: "continuation",
			strategy: "instruction",
			instruction: "Carry the scene forward.",
		});
		expect(continuationIntentFor(configuredSettings({
			continuationStrategy: "assistant-prefill",
			continuationPrefillSuffix: "\n\n",
		}))).toEqual({
			type: "continuation",
			strategy: "assistant-prefill",
			suffix: "\n\n",
		});
	});
});
