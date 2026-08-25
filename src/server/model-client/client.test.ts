import { describe, expect, test } from "bun:test";
import {
	collectModelClientContent,
	createFakeModelClient,
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

describe("Model Client seam", () => {
	test("the fake client streams a complete ordinary result without network access", async () => {
		let receivedPlan: PromptPlan | undefined;
		const client = createFakeModelClient(({ promptPlan }) => {
			receivedPlan = promptPlan;
			return "A complete reply.";
		});

		await expect(
			collectModelClientContent(client, { promptPlan: plan }),
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
			collectModelClientContent(client, { promptPlan: plan }),
		).rejects.toThrow(ModelClientProtocolError);
	});
});
