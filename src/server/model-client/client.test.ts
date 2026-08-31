import { describe, expect, test } from "bun:test";
import {
	collectModelClientGeneration,
	collectModelClientContent,
	createFakeModelClient,
	ModelClientGenerationError,
	ModelClientProtocolError,
} from ".";
import type { PromptPlan } from "../prompt-compiler";

const plan: PromptPlan = {
	blocks: [
		{
			kind: "system-instruction",
			content: "Keep this plan opaque to the transport.",
		},
	],
	warnings: [],
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
	test("the fake client streams a complete ordinary result without network access", async () => {
		let receivedPlan: PromptPlan | undefined;
		const client = createFakeModelClient(({ promptPlan }) => {
			receivedPlan = promptPlan;
			return "A complete reply.";
		});

		await expect(
			collectModelClientContent(client, {
				promptPlan: plan,
				historyRoles: [],
				modelId: "test-model",
				generationSettings: testGenerationSettings,
			}),
		).resolves.toBe("A complete reply.");
		expect(receivedPlan).toBe(plan);
	});

	test("an incomplete stream is rejected at the seam", async () => {
		const client = {
			async *generate() {
				yield { type: "content" as const, text: "partial" };
			},
		};

		await expect(
			collectModelClientContent(client, {
				promptPlan: plan,
				historyRoles: [],
				modelId: "test-model",
				generationSettings: testGenerationSettings,
			}),
		).rejects.toThrow(ModelClientProtocolError);
	});

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
			historyRoles: [],
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
				historyRoles: [],
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
