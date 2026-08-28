import { describe, expect, test } from "bun:test";
import {
	decodeGenerationProvenance,
	decodeStoredGenerationProvenance,
	encodeGenerationProvenance,
	parseGenerationJson,
	readGenerationTerminalMetadata,
} from "./generation-provenance";

const startProvenance = {
	connectionProfileId: 4,
	connectionSettingsRevision: 8,
	modelBackend: "ai-sdk",
	adapter: "openai-compatible",
	modelId: "test-model",
	generationSettings: {
		temperature: 0.7,
		topP: 0.9,
		frequencyPenalty: 0,
		presencePenalty: 0,
		contextLimit: 4096,
		responseBudget: 256,
		safetyAllowance: 32,
		siblingGenerationLimit: 4,
		continuationStrategy: "instruction" as const,
		continuationInstruction: "Continue.",
		continuationPrefillSuffix: "" as const,
	},
	usage: null,
	finishReason: null,
	status: null,
	interruptionCause: null,
};

describe("generation provenance codec", () => {
	test("round-trips the persisted start record into terminal transport details", () => {
		const encoded = encodeGenerationProvenance(startProvenance);
		const data = [
			{ namespace: "generation", key: "outcome", value: "length-limited" },
			{ namespace: "generation", key: "usage", value: JSON.stringify({ inputTokens: 12, outputTokens: 7, totalTokens: 19 }) },
			{ namespace: "generation", key: "finish", value: JSON.stringify({ reason: "length" }) },
		];

		expect(decodeStoredGenerationProvenance(parseGenerationJson(encoded, null), data)).toEqual({
			...startProvenance,
			usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
			finishReason: "length",
			status: "length-limited",
		});
		expect(readGenerationTerminalMetadata(data)).toEqual({
			status: "length-limited",
			usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
			finishReason: "length",
			interruptionCause: undefined,
		});
	});

	test("projects malformed legacy fields to the safe nullable allow-list", () => {
		const legacy = parseGenerationJson(JSON.stringify({
			connectionProfileId: "not-a-number",
			modelBackend: 12,
			generationSettings: {
				temperature: "not-a-number",
				contextLimit: 2.5,
				continuationStrategy: "unknown",
			},
			status: "unknown",
		}), null);
		const details = decodeStoredGenerationProvenance(legacy, []);

		expect(details).toMatchObject({
			connectionProfileId: null,
			modelBackend: null,
			generationSettings: {
				temperature: null,
				contextLimit: null,
				continuationStrategy: null,
			},
			status: "complete",
		});
	});

	test("requires the terminal shape at the transport boundary", () => {
		expect(decodeGenerationProvenance({
			...startProvenance,
			status: null,
		})).toBeUndefined();
		const missingSettings = parseGenerationJson(JSON.stringify({
			status: "complete",
		}), null);
		expect(decodeGenerationProvenance(missingSettings)).toBeUndefined();
	});
});
