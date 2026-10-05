import { describe, expect, test } from "bun:test";
import {
	assertGenerationPlan,
	compileGenerationPlan,
	continuationIntentFor,
	type GenerationPlan,
} from ".";
import {
	PromptBudgetExceededError,
	type CompilePromptDefinition,
	type PromptContextEntry,
} from "../prompt-compiler";
import type { CanonicalGenerationSettings } from "../../shared/contract/generation-settings";
import type { MemoryActivationRecord, MemoryRecallCandidateRecord } from "../../shared/contract/memory-recall";
import { createMacroAttemptState } from "../../shared/prompt-macro-engine";

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
	repeatedImagePlacement: "last",
	requestOverrides: {
		"chat-completions": { logit_bias: { "50256": -100 } },
		responses: { metadata: { workspace: "responses-only" } },
		"anthropic-messages": { metadata: { workspace: "anthropic-only" } },
	},
	...overrides,
});

const entry = (
	speakerName: string,
	content: string,
	role: PromptContextEntry["role"],
): PromptContextEntry => ({ kind: "message", speakerName, content, role });

const memoryCandidate = (identity: string, claim: string, sourcePosition = 0): MemoryRecallCandidateRecord => ({
	identity,
	messageId: sourcePosition + 1,
	variantId: sourcePosition + 1,
	collectionRevision: 1,
	ownership: "automatic",
	sourceChanged: false,
	claimIndex: 0,
	claim,
	attribution: "Narrated event",
	people: [],
	evidence: [{ messageId: sourcePosition + 1, excerpt: claim }],
	sourcePosition,
	semanticSimilarity: 0.9,
	semanticRank: 1,
	recentRank: null,
	relevance: "useful",
	relevanceScore: 2,
	admission: "admitted",
});

const memoryActivation = (candidates: readonly MemoryRecallCandidateRecord[], allowance = 2_048): MemoryActivationRecord => ({
	version: 1,
	state: "ready",
	allowance,
	eligibleSourceCount: candidates.length,
	readyRecordCount: candidates.length,
	embeddingModel: "test-embedding",
	embeddingDeadlineMs: 1_000,
	jevModel: "jev-1.13.0",
	jevConfigured: true,
	relevanceMinimum: 1.5,
	pendingSourceCount: 0,
	pendingIndexCount: 0,
	failedIndexCount: 0,
	failedSourceCount: 0,
	sourceSnapshotFingerprint: "sources",
	embeddingConfigurationFingerprint: "embedding",
	scanMessageIds: [],
	scanTruncated: false,
	scene: "Current scene",
	semanticShortlistCount: candidates.length,
	recentShortlistCount: 0,
	candidates: [...candidates],
	automaticMemoryText: "",
	finalMemoryText: "",
	manuallyEdited: false,
});

// The transcript length is a monotone stand-in for a tokenizer: a longer
// Prompt Plan estimates higher, so budget outcomes stay deterministic.
const transcriptLengthEstimator = (transcript: string) => transcript.length;

// The order the stored Default preset ships with, restated here so the pure
// compiler can be exercised without a database.
const defaultRecipe: Parameters<typeof compileGenerationPlan>[0]["recipe"] = [
	{ reference: "model-system-instruction", enabled: true, role: "system" },
	{ reference: "human-identity", enabled: true, role: "user" },
	{ reference: "model-identity", enabled: true, role: "assistant" },
	{ reference: "model-scenario", enabled: true, role: "system" },
	{ reference: "model-example-dialogue", enabled: true, role: "user" },
	{ reference: "history", enabled: true },
	{ reference: "model-post-history-instruction", enabled: true, role: "system" },
];

const compile = (
	overrides: Partial<Parameters<typeof compileGenerationPlan>[0]> = {},
): GenerationPlan => compileGenerationPlan({
	human,
	model,
	recipe: defaultRecipe,
	context: [entry("Maren", "The lamp turns above you.", "model")],
	settings: configuredSettings(),
	connection: { apiFormat: "chat-completions", supportsImages: true },
	estimator: transcriptLengthEstimator,
	imageLookup: () => undefined,
	...overrides,
});

describe("Generation Plan Compiler", () => {
	test("admits Lore by Always, priority, and stable source order", () => {
		const recipe = [
			{ reference: "lore", enabled: true, role: "system" },
		] as const;
		const entries = [
			{ content: "priority", priority: 5, bookOrder: 2, entryOrder: 1 },
			{ content: "always", always: true, priority: -10, bookOrder: 9, entryOrder: 9 },
			{ content: "tie-first", priority: 5, bookOrder: 1, entryOrder: 3 },
			{ content: "tie-second", priority: 5, bookOrder: 1, entryOrder: 4 },
		];
		const plan = compile({
			recipe,
			context: [],
			lore: entries,
			loreAllowance: 2_048,
		});

		expect(plan.promptPlan.blocks).toEqual([{
			kind: "lore",
			role: "system",
			content: "always\n\ntie-first\n\ntie-second\n\npriority",
		}]);
	});

	test("skips an oversized Lore entry and continues with later entries", () => {
		const recipe = [{ reference: "lore", enabled: true, role: "system" }] as const;
		const plan = compile({
			recipe,
			context: [],
			lore: [
				{ content: "too-large" },
				{ content: "ok" },
			],
			loreAllowance: 3,
			estimator: (transcript) => {
				const content = transcript.split("\u001eCONTENT\u001f")[1] ?? "";
				return content.length;
			},
		});

		expect(plan.promptPlan.blocks).toEqual([{
			kind: "lore",
			role: "system",
			content: "ok",
		}]);
	});

	test("retains Lore budget admissions and omissions in activation evidence", () => {
		const plan = compile({
			recipe: [{ reference: "lore", enabled: true, role: "system" }],
			lore: [
				{ content: "too-large", bookId: 4, entryId: 8 },
				{ content: "ok", bookId: 4, entryId: 9 },
			],
			loreAllowance: 3,
			estimator: (transcript) => (transcript.split("\u001eCONTENT\u001f")[1] ?? "").length,
			loreActivation: {
				version: 1,
				mode: "keyword-fallback",
				evidence: [],
				automaticLoreText: "",
				finalLoreText: "",
				manuallyEdited: false,
			},
		});

		expect(plan.loreActivation?.evidence).toContainEqual({
			budget: {
				allowance: 3,
				candidates: [
					{ bookId: 4, entryId: 8, admitted: false, reason: "oversized" },
					{ bookId: 4, entryId: 9, admitted: true, reason: "admitted" },
				],
			},
		});
	});

	test("measures the complete admitted Lore set instead of summing rounded totals", () => {
		const plan = compile({
			recipe: [{ reference: "lore", enabled: true, role: "system" }],
			context: [],
			lore: [{ content: "a" }, { content: "b" }],
			loreAllowance: 5,
			estimator: (transcript) => {
				const content = transcript.split("\u001eCONTENT\u001f")[1] ?? "";
				return content.length;
			},
		});

		expect(plan.promptPlan.blocks).toEqual([{
			kind: "lore",
			role: "system",
			content: "a\n\nb",
		}]);
	});

	test("admits whole Memory claims against their allowance and records each omission", () => {
		const candidates = [
			memoryCandidate("large", "oversized claim"),
			memoryCandidate("small", "fits"),
		];
		const plan = compile({
			recipe: [{ reference: "memory", enabled: true, role: "system" }],
			context: [],
			memoryActivation: memoryActivation(candidates, 6),
			estimator: (transcript) => transcript.includes("oversized claim") ? 20 : transcript.includes("fits") ? 4 : 0,
		});

		expect(plan.promptPlan.blocks).toEqual([{
			kind: "memory",
			role: "system",
			content: "fits (attribution: Narrated event)",
		}]);
		expect(plan.memoryActivation?.candidates.map(({ identity, admission }) => [identity, admission])).toEqual([
			["large", "oversized"],
			["small", "admitted"],
		]);
		expect(plan.memoryActivation?.automaticMemoryText).toBe("fits (attribution: Narrated event)");
	});

	test("admits more relevant Memory claims before shortlist order", () => {
		const candidates = [
			{ ...memoryCandidate("lower", "lower relevance"), relevanceScore: 1.7 },
			{ ...memoryCandidate("higher", "higher relevance"), relevanceScore: 2.9 },
		];
		const plan = compile({
			recipe: [{ reference: "memory", enabled: true, role: "system" }],
			context: [],
			memoryActivation: memoryActivation(candidates, 4),
			estimator: (transcript) => (transcript.includes("lower relevance") ? 4 : 0) + (transcript.includes("higher relevance") ? 4 : 0),
		});

		expect(plan.memoryActivation?.candidates.map(({ identity, admission }) => [identity, admission])).toEqual([
			["lower", "allowance"],
			["higher", "admitted"],
		]);
	});

	test("lets Prompt Preset order decide which dynamic block wins shared context space", () => {
		const memory = memoryCandidate("memory", "memory fact");
		const activation = memoryActivation([memory]);
		const estimate = (transcript: string) =>
			(transcript.includes("lore fact") ? 60 : 0) + (transcript.includes("memory fact") ? 60 : 0);
		const loreFirst = compile({
			recipe: [
				{ reference: "lore", enabled: true, role: "system" },
				{ reference: "memory", enabled: true, role: "system" },
			],
			context: [],
			lore: [{ content: "lore fact" }],
			loreAllowance: 100,
			memoryActivation: { ...activation, allowance: 100 },
			settings: configuredSettings({ contextLimit: 70, responseBudget: 1, safetyAllowance: 0 }),
			estimator: estimate,
		});
		const memoryFirst = compile({
				recipe: [
					{ reference: "memory", enabled: true, role: "system" },
					{ reference: "lore", enabled: true, role: "system" },
				],
				context: [],
				lore: [{ content: "lore fact" }],
				loreAllowance: 100,
				memoryActivation: { ...activation, allowance: 100 },
				settings: configuredSettings({ contextLimit: 70, responseBudget: 1, safetyAllowance: 0 }),
				estimator: estimate,
			});

		expect(loreFirst.promptPlan.blocks.map((block) => block.kind)).toEqual(["lore"]);
		expect(loreFirst.memoryActivation?.candidates[0]?.admission).toBe("context-limit");
		expect(memoryFirst.promptPlan.blocks.map((block) => block.kind)).toEqual(["memory"]);
		expect(memoryFirst.loreActivation).toBeNull();
	});

	test("budgets Lore against the protected history before trimming older history", () => {
		const recipe = [
			{ reference: "lore", enabled: true, role: "system" },
			{ reference: "history", enabled: true },
		] as const;
		const plan = compile({
			recipe,
			context: [
				entry("Maren", "old", "model"),
				entry("Writer", "latest", "human"),
			],
			lore: [{ content: "fact" }],
			loreAllowance: 2_048,
			settings: configuredSettings({ contextLimit: 180, responseBudget: 1, safetyAllowance: 0 }),
			estimator: (transcript) => transcript.length,
		});

		expect(plan.budget.fits).toBe(true);
		expect(plan.budget.omittedContext).toEqual([entry("Maren", "old", "model")]);
		expect(plan.promptPlan.blocks).toEqual([
			{ kind: "lore", role: "system", content: "fact" },
			{ kind: "history", speakerName: "Writer", content: "latest", role: "human" },
		]);
	});

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
			siblingGenerationLimit: null,
			continuationStrategy: null,
			continuationInstruction: null,
			continuationPrefillSuffix: null,
			repeatedImagePlacement: "last",
			requestOverrides: { logit_bias: { "50256": -100 } },
		});
		expect(plan.budget.fits).toBe(true);
		expect(plan.budget.contextLimit).toBe(100_000);
		expect(plan.budget.responseBudget).toBe(1024);
		expect(plan.budget.safetyAllowance).toBe(500);
	});

	test("excludes the unused Sibling Generation limit from Effective Generation Settings", () => {
		const plan = compile({
			settings: configuredSettings({ siblingGenerationLimit: 9 }),
			intent: { type: "sibling" },
		});

		expect(plan.effectiveSettings.siblingGenerationLimit).toBeNull();
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
			repeatedImagePlacement: "last",
		});
		const intent = continuationIntentFor(settings);
		const plan = compile({ intent, context: [
			entry("Writer", "h".repeat(400), "human"),
			entry("Maren", "m".repeat(400), "model"),
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
			repeatedImagePlacement: "last",
		});
		const intent = continuationIntentFor(settings);
		const plan = compile({ intent, context: [
			entry("Writer", "h".repeat(400), "human"),
			entry("Maren", "p".repeat(400), "model"),
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
			connection: { apiFormat: "chat-completions", supportsImages: true },
		});
		const responses = compile({
			connection: { apiFormat: "responses", supportsImages: true },
		});
		const anthropicMessages = compile({
			connection: { apiFormat: "anthropic-messages", supportsImages: true },
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

	test("applies no Request Overrides without a selected Profile", () => {
		const plan = compile({ connection: null });

		expect(plan.effectiveSettings.requestOverrides).toEqual({});
	});

	test("reuses one macro attempt while trimming history", () => {
		const randomValues = [0, 0.999];
		let randomCalls = 0;
		const plan = compile({
			human: {
				...human,
				prompt: { ...human.prompt, identity: "{{random::a::b}}" },
			},
			context: [
				entry("Maren", "old", "model"),
				entry("Writer", "keep", "human"),
			],
			recipe: [
				{ reference: "human-identity", enabled: true, role: "user" },
				{ reference: "history", enabled: true },
			],
			settings: configuredSettings({ contextLimit: 50, responseBudget: 1, safetyAllowance: 0 }),
			attempt: {
				environment: {
					self: "Writer",
					other: "Maren",
					random: () => randomValues[randomCalls++] ?? 0.999,
				},
				state: createMacroAttemptState(),
			},
			estimator: (transcript) => transcript.includes("old") ? 100 : 0,
		});

		expect(randomCalls).toBe(1);
		expect(plan.budget.omittedContext).toEqual([entry("Maren", "old", "model")]);
		expect(plan.promptPlan.blocks[0]?.content).toBe("a");
	});

	test("protects the prefill prefix instead of the latest human entry", () => {
		const settings = configuredSettings({
			contextLimit: 1000,
			responseBudget: 10,
			safetyAllowance: 0,
			continuationStrategy: "assistant-prefill",
			continuationPrefillSuffix: " ",
			repeatedImagePlacement: "last",
		});
		const plan = compile({
			settings,
			intent: continuationIntentFor(settings),
			context: [entry("Writer", "h".repeat(400), "human"), entry("Maren", "p".repeat(400), "model")],
		});

		// The history shrank before the prefix: the human entry was omitted
		// while the prefill prefix stayed protected.
		expect(plan.budget.fits).toBe(true);
		expect(plan.budget.omittedContext).toEqual([entry("Writer", "h".repeat(400), "human")]);
		expect(plan.promptPlan.blocks.filter((block) => block.kind === "history")).toEqual([
			{ kind: "history", speakerName: "Maren", content: "p".repeat(400), role: "model" },
		]);
	});

	test("reports an impossible protected prefill prefix as a budget failure", () => {
		const settings = configuredSettings({
			contextLimit: 200,
			responseBudget: 10,
			safetyAllowance: 0,
			continuationStrategy: "assistant-prefill",
			continuationPrefillSuffix: " ",
			repeatedImagePlacement: "last",
		});
		const plan = compile({
			settings,
			intent: continuationIntentFor(settings),
			context: [entry("Writer", "h".repeat(400), "human"), entry("Maren", "p".repeat(400), "model")],
		});

		expect(plan.budget.fits).toBe(false);
		expect(plan.budget.failure?.reason).toBe("protected-history-too-large");
		// The failing candidate still protects the prefill prefix and omits
		// the human entry, so the breakdown describes a real candidate.
		expect(plan.promptPlan.blocks.filter((block) => block.kind === "history")).toEqual([
			{ kind: "history", speakerName: "Maren", content: "p".repeat(400), role: "model" },
		]);
		expect(plan.budget.omittedContext).toEqual([entry("Writer", "h".repeat(400), "human")]);
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
			context: [entry("Writer", "h".repeat(400), "human"), entry("Maren", "m".repeat(400), "model")],
		});

		expect(plan.budget.fits).toBe(true);
		// The latest human entry stays protected; the older model entry is the
		// whole-history omission.
		expect(plan.budget.omittedContext).toEqual([entry("Maren", "m".repeat(400), "model")]);
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
			context: [entry("Maren", "m".repeat(400), "model"), entry("Writer", "h".repeat(400), "human")],
		});

		expect(plan.budget.fits).toBe(true);
		expect(plan.budget.omittedContext).toEqual([entry("Maren", "m".repeat(400), "model")]);
		expect(plan.promptPlan.blocks.filter((block) => block.kind === "history")).toEqual([
			{ kind: "history", speakerName: "Writer", content: "h".repeat(400), role: "human" },
		]);
	});

	test("fails clearly when an assistant-prefill Continuation has no preceding model history", () => {
		const settings = configuredSettings({
			continuationStrategy: "assistant-prefill",
			continuationPrefillSuffix: " ",
			repeatedImagePlacement: "last",
		});
		expect(() => compile({
			intent: continuationIntentFor(settings),
			context: [],
		})).toThrow(
			"An assistant-prefill Continuation requires preceding model history to prefill from.",
		);
	});

	test("assertGenerationPlan enforces the budget decision for execution", () => {
		const fitting = compile();
		expect(assertGenerationPlan(fitting)).toEqual(fitting);

		const impossible = compile({
			settings: configuredSettings({ contextLimit: 200 }),
			context: [entry("Writer", "h".repeat(400), "human"), entry("Maren", "m".repeat(400), "model")],
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
			repeatedImagePlacement: "last",
		}))).toEqual({
			type: "continuation",
			strategy: "assistant-prefill",
			suffix: "\n\n",
		});
	});
});
