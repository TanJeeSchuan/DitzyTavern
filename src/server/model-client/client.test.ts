import { describe, expect, test } from "bun:test";
import {
	collectModelClientGeneration,
	createFakeModelClient,
	ModelClientGenerationError,
} from ".";
import type { PromptPlan } from "../prompt-compiler";

const plan: PromptPlan = {
	blocks: [
		{
			kind: "system-instruction",
			role: "system",
			content: "Keep this plan opaque to the transport.",
		},
	],
	warnings: [], images: [],
};

const testGenerationSettings = {
	temperature: null,
	topP: null,
	frequencyPenalty: null,
	presencePenalty: null,
	contextLimit: 100,
	responseBudget: 16,
	requestOverrides: {},
};

describe("Model Client seam", () => {
	test("collects visible content, separate reasoning, usage, and length metadata", async () => {
		const client = createFakeModelClient(() => [
			{ type: "reasoning", text: "First think. " },
			{ type: "content", text: "Visible " },
			{ type: "usage", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
			{ type: "content", text: "answer." },
			{ type: "finished", finishReason: "length" },
		]);

		await expect(collectModelClientGeneration(client, {
			promptPlan: plan,
			modelId: "test-model",
			generationSettings: testGenerationSettings,
		})).resolves.toEqual({
			content: "Visible answer.",
			reasoning: "First think. ",
			usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
			finishReason: "length",
		});
	});

	test("turns normalized failed outcomes into typed generation errors", async () => {
		const client = createFakeModelClient(() => [
			{ type: "failed", kind: "inactivity", message: "The stream became inactive." },
		]);

		try {
			await collectModelClientGeneration(client, {
				promptPlan: plan,
				modelId: "test-model",
				generationSettings: testGenerationSettings,
			});
			throw new Error("Expected a typed generation error.");
		} catch (error) {
			expect(error).toBeInstanceOf(ModelClientGenerationError);
			if (!(error instanceof ModelClientGenerationError)) return;
			expect(error.kind).toBe("inactivity");
			expect(error.message).toBe("The stream became inactive.");
		}
	});
});
