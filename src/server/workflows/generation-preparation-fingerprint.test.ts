import { describe, expect, test } from "bun:test";
import { DEFAULT_CONVERSATION_GENERATION_SETTINGS } from "../conversation/generation-settings";
import { effectiveGenerationSettingsFor } from "../generation-plan";
import type { GenerationPreparationSnapshot } from "./generate-capture";
import { generationPreparationFingerprint } from "./generation-preparation-fingerprint";
import type { SemanticSettingsSnapshot } from "../lorebook/semantic";

const emptyPrompt = {
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
};

const participant = (id: number, name: string) => ({
	id,
	position: id - 1,
	name,
	prompt: emptyPrompt,
	openings: [],
	sourceCharacterId: null,
	sourceCharacterName: null,
	duplicateLabel: name,
	removal: {
		eligible: false,
		reason: "control-assigned" as const,
		deletionMode: null,
		affectedGenerationCount: 0,
	},
});

const preparationWithSemanticSettings = (semanticSettings: SemanticSettingsSnapshot): GenerationPreparationSnapshot => {
	const settings = DEFAULT_CONVERSATION_GENERATION_SETTINGS;
	return {
		kind: "send",
		conversationId: 1,
		authorNote: "",
		semanticTriggerRevision: 0,
		formatting: {},
		derivation: {
			human: participant(1, "Writer"),
			model: participant(2, "Maren"),
			context: [],
		},
		participation: {
			messages: [],
			control: { humanParticipantId: 1, modelParticipantId: 2 },
		},
		settings,
		intent: undefined,
		pendingHumanText: undefined,
		effectiveSettings: effectiveGenerationSettingsFor(settings, undefined, null),
		recipe: { id: 1, name: "Default", slots: [] },
		connection: null,
		macroState: new Map<string, never>(),
		lore: {
			candidates: [],
			activation: {
				version: 1,
				mode: "semantic",
				evidence: [],
				automaticLoreText: "",
				finalLoreText: "",
				manuallyEdited: false,
			},
			scan: [],
			matches: [],
			allowance: 2048,
			sources: {
				scanMessages: [],
				eligibleUses: [],
				books: [],
				allowance: 2048,
				semanticSettings,
			},
		},
		memory: {
			freshnessFingerprint: "memory",
			activation: {
				version: 1,
				state: "disabled",
				allowance: 2_048,
				eligibleSourceCount: 0,
				readyRecordCount: 0,
				embeddingModel: "",
				embeddingDeadlineMs: 1_000,
				decisionProfileName: null, decisionModel: "jev-1.13.0",
				decisionConfigured: false,
				relevanceMinimum: 1.5,
				pendingSourceCount: 0,
				pendingIndexCount: 0,
				failedIndexCount: 0,
				failedSourceCount: 0,
				sourceSnapshotFingerprint: "sources",
				embeddingConfigurationFingerprint: "embedding",
				scanMessageIds: [],
				scanTruncated: false,
				scene: "",
				semanticShortlistCount: 0,
				recentShortlistCount: 0,
				candidates: [],
				automaticMemoryText: "",
				finalMemoryText: "",
				manuallyEdited: false,
			},
			embedding: { spaceKey: "", endpoint: "", model: "", deadlineMs: 1_000 },
			indexed: [],
			recent: [], kind: "off",
		},
		content: "Hello",
		reuseHumanMessageId: undefined,
	};
};

const settings = { decisionProfileId: 1, decisionModel: "jev-1.13.0", decisionStateTokenLimit: 16000, triggerThreshold: 0.5, kind: "ready", decision: { profileName: "Decision test", model: "jev-1.13.0", stateTokenLimit: 16000, endpoint: "http://decision.test/v1/systemone", credential: "secret", headers: {}, timeoutMs: 15000 } } satisfies SemanticSettingsSnapshot;

describe("generation preparation snapshot fingerprint", () => {
	test("changes when any Semantic Trigger configuration field changes", () => {
		const baseline = generationPreparationFingerprint(preparationWithSemanticSettings(settings));
		for (const changed of [{ ...settings, decisionProfileId: null }, { ...settings, decisionStateTokenLimit: 2000 }, { ...settings, triggerThreshold: 0.8 }, { ...settings, decisionModel: "jev-next" }]) {
			expect(generationPreparationFingerprint(preparationWithSemanticSettings(changed))).not.toBe(baseline);
		}
	});
});
