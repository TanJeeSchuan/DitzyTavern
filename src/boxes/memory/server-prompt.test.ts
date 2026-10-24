import { describe, expect, test } from "bun:test";
import { compileGenerationPlan } from "../../server/generation-plan";
import { DEFAULT_CONVERSATION_GENERATION_SETTINGS } from "../../server/conversation";
import { createMacroAttemptState } from "../../shared/prompt-macro-engine";
import type { MemoryActivationRecord, MemoryRecallCandidateRecord } from "./contract";
import { memoryItems } from "./server-prompt";

const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
const compile = (overrides: Partial<Parameters<typeof compileGenerationPlan>[0]>) => compileGenerationPlan({
	boxes: {}, human: { name: "Writer", prompt }, model: { name: "Maren", prompt }, recipe: [], context: [],
	settings: DEFAULT_CONVERSATION_GENERATION_SETTINGS, connection: null,
	images: { lookup: () => undefined, placement: "last", sendImages: true }, ...overrides,
});

const memoryCandidate = (identity: string, claim: string, sourcePosition = 0): MemoryRecallCandidateRecord => ({
	identity,
	messageId: sourcePosition + 1,
	variantId: sourcePosition + 1,
	writer: false,
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
	state: "ready",
	allowance,
	eligibleSourceCount: candidates.length,
	readyRecordCount: candidates.length,
	embeddingModel: "test-embedding",
	embeddingDeadlineMs: 1_000,
	decisionProfileName: null, decisionModel: "jev-1.13.0",
	decisionConfigured: true,
	relevanceMinimum: 1.5,
	pendingSourceCount: 0,
	failedSourceCount: 0,
	sourceSnapshotFingerprint: "sources",
	embeddingConfigurationFingerprint: "embedding",
	scanMessageIds: [],
	scanTruncated: false,
	scene: "Current scene",
	semanticShortlistCount: candidates.length,
	recentShortlistCount: 0,
	candidates: [...candidates],
});

describe("Memory prompt admission", () => {
	test("admits whole Memory claims against their allowance and records each omission", () => {
		const candidates = [
			memoryCandidate("large", "oversized claim"),
			memoryCandidate("small", "fits"),
		];
		const plan = compile({
			recipe: [{ reference: "box:memory", enabled: true, role: "system", content: "" }],
			context: [],
			boxes: { "box:memory": memoryItems(memoryActivation(candidates, 6)) },
			estimator: (transcript) => transcript.includes("oversized claim") ? 20 : transcript.includes("fits") ? 4 : 0,
		});

		expect(plan.promptPlan.blocks).toEqual([{
			kind: "box:memory",
			role: "system",
			content: "fits (attribution: Narrated event)",
		}]);
		expect(plan.boxTraces["box:memory"]).toMatchObject({
			allowance: 6,
			items: [{ text: "oversized claim (attribution: Narrated event)", admission: "oversized" }, { text: "fits (attribution: Narrated event)", admission: "admitted" }],
			automaticText: "fits (attribution: Narrated event)",
			finalText: "fits (attribution: Narrated event)",
		});
	});

	test("admits more relevant Memory claims before shortlist order", () => {
		const candidates = [
			{ ...memoryCandidate("lower", "lower relevance"), relevanceScore: 1.7 },
			{ ...memoryCandidate("higher", "higher relevance"), relevanceScore: 2.9 },
		];
		const plan = compile({
			recipe: [{ reference: "box:memory", enabled: true, role: "system", content: "" }],
			context: [],
			boxes: { "box:memory": memoryItems(memoryActivation(candidates, 4)) },
			estimator: (transcript) => (transcript.includes("lower relevance") ? 4 : 0) + (transcript.includes("higher relevance") ? 4 : 0),
		});

		expect(plan.boxTraces["box:memory"]?.items).toEqual([
			{ text: "higher relevance (attribution: Narrated event)", admission: "admitted" },
			{ text: "lower relevance (attribution: Narrated event)", admission: "allowance" },
		]);
	});

	test("renders recalled Memory claims literally, even while budgeting", () => {
		const state = createMacroAttemptState();
		const plan = compile({
			recipe: [{ reference: "box:memory", enabled: true, role: "system", content: "" }],
			context: [],
			boxes: { "box:memory": memoryItems(memoryActivation([memoryCandidate("macro", "{{setvar::mood::grim}}{{self}} waits")])) },
			attempt: { environment: { self: "Writer", other: "Maren" }, state },
		});
		expect(plan.promptPlan.blocks[0]?.content).toBe("{{setvar::mood::grim}}{{self}} waits (attribution: Narrated event)");
		expect(state.writes).toEqual([]);
	});
});
