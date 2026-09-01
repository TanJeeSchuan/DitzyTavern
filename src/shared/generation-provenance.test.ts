import { describe, expect, test } from "bun:test";
import {
	decodeGenerationProvenance,
	decodeGenerationProvenanceRecord,
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

	test("ignores the removed legacy embedded finish record", () => {
		// Terminal finish reasons come only from the server-owned terminal
		// metadata data entries; the embedded older-row `finish` object is no
		// longer a fallback source for the decoded record.
		const legacy = decodeGenerationProvenanceRecord({
			connectionProfileId: 4,
			generationSettings: {},
			finish: { reason: "length" },
			status: "complete",
		});
		expect(legacy?.finishReason).toBeNull();
	});

	test("decodes retained settings with per-field intentional nullability", () => {
		const decoded = decodeGenerationProvenanceRecord({
			generationSettings: {
				temperature: "not-a-number",
				topP: 0.9,
				contextLimit: 2.5,
				responseBudget: 256,
				safetyAllowance: 0,
				siblingGenerationLimit: 4.5,
				continuationStrategy: "auto",
				continuationInstruction: "Keep the voice.",
				continuationPrefillSuffix: " ",
				futureField: "ignored like every unknown wire field",
			},
		});

		// Absent and corrupt values decode as null; the Safety allowance accepts
		// zero; closed Continuation literals decode exactly.
		expect(decoded?.generationSettings).toEqual({
			temperature: null,
			topP: 0.9,
			frequencyPenalty: null,
			presencePenalty: null,
			contextLimit: null,
			responseBudget: 256,
			safetyAllowance: 0,
			siblingGenerationLimit: null,
			continuationStrategy: null,
			continuationInstruction: "Keep the voice.",
			continuationPrefillSuffix: " ",
		});

		// A wholly absent settings object decodes as the all-null projection —
		// an absence no capture of validated settings could ever produce, which
		// is exactly why the projection's nullability is explicit.
		expect(decodeGenerationProvenanceRecord({})?.generationSettings).toEqual({
			temperature: null,
			topP: null,
			frequencyPenalty: null,
			presencePenalty: null,
			contextLimit: null,
			responseBudget: null,
			safetyAllowance: null,
			siblingGenerationLimit: null,
			continuationStrategy: null,
			continuationInstruction: null,
			continuationPrefillSuffix: null,
		});
	});
});
