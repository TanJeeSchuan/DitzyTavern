import { describe, expect, test } from "bun:test";
import { variantDataCodecs } from "./variant-data-codecs";

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
		repeatedImagePlacement: "last" as const,
	},
	usage: null,
	finishReason: null,
	status: null,
	interruptionCause: null,
};

const codec = variantDataCodecs.provenance;
const provenanceEntry = (value: string) => ({ namespace: "generation", key: "provenance", value });

describe("generation provenance codec", () => {
	test("round-trips the persisted start record into terminal transport details", () => {
		const data = [
			{ namespace: "generation", key: "outcome", value: "length-limited" },
			{ namespace: "generation", key: "usage", value: JSON.stringify({ inputTokens: 12, outputTokens: 7, totalTokens: 19 }) },
			{ namespace: "generation", key: "finish", value: JSON.stringify({ reason: "length" }) },
		];
		const terminal = codec.terminal(codec.encode(startProvenance), data, "Active Generation 3");

		expect(codec.read([provenanceEntry(terminal)], "Variant 9")).toEqual({
			...startProvenance,
			usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
			finishReason: "length",
			status: "length-limited",
		});
	});

	test("properties outside the provenance allow-list are dropped, never retained", () => {
		const leaky = (status: "complete" | null) => JSON.stringify({
			...startProvenance,
			status,
			requestUrl: "https://secret.invalid",
			generationSettings: { ...startProvenance.generationSettings, requestOverrides: { credential: "do-not-retain" } },
		});
		const data = [{ namespace: "generation", key: "finish", value: JSON.stringify({ reason: "stop", raw: "provider-body" }) }];

		expect(JSON.parse(codec.terminal(leaky(null), data, "Active Generation 3"))).toEqual({ ...startProvenance, finishReason: "stop", status: "complete" });
		expect(codec.read([provenanceEntry(leaky("complete"))], "Variant 9")).toEqual({ ...startProvenance, status: "complete" });
	});

	test("a Variant with terminal metadata but no start record shows every recorded field as unavailable", () => {
		const data = [
			{ namespace: "generation", key: "outcome", value: "interrupted" },
			{ namespace: "generation", key: "interruption-cause", value: "user-stop" },
		];

		expect(codec.read(data, "Variant 9")).toEqual({
			connectionProfileId: null,
			connectionSettingsRevision: null,
			modelBackend: null,
			adapter: null,
			modelId: null,
			generationSettings: {
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
				repeatedImagePlacement: null,
			},
			usage: null,
			finishReason: null,
			status: "interrupted",
			interruptionCause: "user-stop",
		});
		expect(codec.read([], "Variant 9")).toBeNull();
	});

	test.each([
		["malformed JSON", "{"],
		["a settings value outside its field's domain", JSON.stringify({ ...startProvenance, generationSettings: { ...startProvenance.generationSettings, temperature: "warm" } })],
		["a missing field", JSON.stringify({ ...startProvenance, modelId: undefined })],
	])("a persisted record with %s throws an error naming where it was stored", (_case, value) => {
		expect(() => codec.read([provenanceEntry(value)], "Variant 9")).toThrow("Variant 9");
		expect(() => codec.terminal(value, [], "Active Generation 3")).toThrow("Active Generation 3");
	});

	test("corrupt terminal metadata throws an error naming where it was stored", () => {
		const record = provenanceEntry(codec.encode(startProvenance));
		expect(() => codec.read([record, { namespace: "generation", key: "usage", value: "{\"inputTokens\":\"12\"}" }], "Variant 9")).toThrow("Variant 9");
		expect(() => codec.read([record, { namespace: "generation", key: "finish", value: "{\"reason\":\"STOP\"}" }], "Variant 9")).toThrow("Variant 9");
		expect(() => codec.read([record, { namespace: "generation", key: "outcome", value: "exploded" }], "Variant 9")).toThrow("Variant 9");
	});
});
