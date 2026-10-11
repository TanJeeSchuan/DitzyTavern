import { describe, expect, test } from "bun:test";
import { DEFAULT_CONVERSATION_GENERATION_SETTINGS } from "../conversation";
import { effectiveGenerationSettingsFor } from "../generation-plan";
import type { PreparationSnapshot } from "./generate-capture";
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

const preparationWithSemanticSettings = (semanticSettings: SemanticSettingsSnapshot): PreparationSnapshot => {
	const settings = DEFAULT_CONVERSATION_GENERATION_SETTINGS;
	return {
		seed: "preview-seed",
		target: { kind: "send", content: "" },
		facts: { kind: "send", reuseHumanMessageId: undefined },
		conversationId: 1,
		boxes: [],
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
