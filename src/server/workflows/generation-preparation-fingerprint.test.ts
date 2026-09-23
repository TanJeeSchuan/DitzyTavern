import { describe, expect, test } from "bun:test";
import { DEFAULT_CONVERSATION_GENERATION_SETTINGS } from "../conversation/generation-settings";
import { effectiveGenerationSettingsFor } from "../generation-plan";
import type { GenerationPreparation } from "./generate-capture";
import { generationPreparationFingerprint } from "./generation-preparation-fingerprint";

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

const preparationWithEmbeddingSettings = (semanticSettings: {
	endpoint: string;
	model: string;
	threshold: number;
	deadlineMs: number;
	credential: string | null;
}): GenerationPreparation => {
	const settings = DEFAULT_CONVERSATION_GENERATION_SETTINGS;
	return {
		kind: "send",
		conversationId: 1,
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
			activation: {
				version: 1,
				state: "disabled",
				allowance: 2_048,
				eligibleSourceCount: 0,
				readyRecordCount: 0,
				embeddingModel: "",
				embeddingDeadlineMs: 1_000,
				jevModel: "jev-1.13.0",
				jevConfigured: false,
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
			candidates: [],
			fingerprintInputs: {
				enabled: false,
				allowance: 2_048,
				sourceSnapshotFingerprint: "sources",
				embeddingConfigurationFingerprint: "embedding",
				scene: "",
				scanMessageIds: [],
				scanTruncated: false,
				jevModel: "jev-1.13.0",
				jevConfigured: false,
				embeddingModel: "",
				embeddingDeadlineMs: 1_000,
			},
		},
		content: "Hello",
	};
};

const settings = {
	endpoint: "https://embedding.example/v1/embeddings",
	model: "embedding-model-v1",
	threshold: 0.7,
	deadlineMs: 5000,
	credential: "secret",
};

interface Fingerprint {
	lore: {
		embedding: {
			endpoint: string;
			model: string;
			threshold: number;
			deadlineMs: number;
		};
	};
}

describe("generation preparation fingerprint", () => {
	test("captures embedding configuration without its credential", () => {
		// ==[HUMAN APPROVED]== SAFETY: The fingerprint is produced by the function under test and
		// this type describes the fields asserted from its JSON projection.
		const fingerprint = JSON.parse(generationPreparationFingerprint(preparationWithEmbeddingSettings(settings))) as Fingerprint;

		expect(fingerprint.lore.embedding).toEqual({
			endpoint: settings.endpoint,
			model: settings.model,
			threshold: settings.threshold,
			deadlineMs: settings.deadlineMs,
		});
		expect(JSON.stringify(fingerprint)).not.toContain(settings.credential);
	});

	test("changes when any embedding configuration field changes", () => {
		const baseline = generationPreparationFingerprint(preparationWithEmbeddingSettings(settings));
		for (const field of ["endpoint", "model", "threshold", "deadlineMs"] as const) {
			const changed = {
				...settings,
				[field]: field === "threshold"
					? 0.8
					: field === "deadlineMs"
						? 6000
						: `${settings[field]}-changed`,
			};
			expect(generationPreparationFingerprint(preparationWithEmbeddingSettings(changed))).not.toBe(baseline);
		}
	});
});
