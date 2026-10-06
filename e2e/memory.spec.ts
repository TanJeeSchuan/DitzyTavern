import type { APIRequestContext } from "@playwright/test";
import { test, expect, enableJev, send, story } from "./fixtures";
import type { JevRule } from "./protocol";

const enableMemory = async (request: APIRequestContext) => {
	const { profiles } = await (await request.get("/api/connection-settings")).json();
	const profileId = (apiFormat: string) => profiles.find((profile: { apiFormat: string }) => profile.apiFormat === apiFormat).id;
	const { revision, ...settings } = await (await request.get("/api/memory-settings")).json();
	await request.post("/api/memory-settings/commands", { data: {
		...settings, expectedRevision: revision, enabled: true,
		extractionProfileId: profileId("chat-completions"), extractionModel: "e2e-model",
		embeddingProfileId: profileId("embeddings"), embeddingModel: "e2e-embedding",
	} });
};

const choice = (selected: string, labels: string[]) => ({
	type: "choice" as const, choice: selected, confidence: 0.9,
	probabilities: Object.fromEntries(labels.map((label) => [label, label === selected ? 0.9 : 0.1 / (labels.length - 1)])),
});

const judge = (claim: string, verdict: { support: string; attribution: string; usefulness: string }): JevRule[] => [
	{ match: [claim, "How does `source` relate to `memory.claim`?"], answer: choice(verdict.support, ["supported", "contradicted", "not_established"]) },
	{ match: [claim, "is `memory.attribution` the one who"], answer: choice(verdict.attribution, ["correct", "misattributed", "unclear"]) },
	{ match: [claim, "still matter to the story"], answer: choice(verdict.usefulness, ["retain", "omit"]) },
];

test("a reply becomes an attributed Memory that the next Generation recalls", async ({ page, request, llm }) => {
	await enableJev(request);
	await enableMemory(request);
	await llm.memories(
		{ claim: "Theodora hid the brass key under the third map.", attribution: "Theodora Kline", people: ["Theodora Kline"], excerpt: "I hid the brass key under the third map." },
		{ claim: "Theodora fears the dark.", attribution: "Theodora Kline", people: ["Theodora Kline"], excerpt: "The dark presses against the dome." },
	);
	await llm.jev(
		...judge("brass key", { support: "supported", attribution: "correct", usefulness: "retain" }),
		...judge("fears the dark", { support: "not_established", attribution: "correct", usefulness: "retain" }),
		{ match: ["brass key", "How much does `memory` help"], answer: { type: "score", score: 3, legend: {}, probabilities: { 0: 0.02, 1: 0.03, 2: 0.05, 3: 0.9 }, confidence: 0.9 } },
	);
	await llm.chat(
		{ chunks: ["She leans close. \"I hid the brass key under the third map. The dark presses against the dome.\""] },
		{ chunks: ["She taps the map twice."] },
	);

	await page.goto("/");
	await send(page, "Where is the key?");
	await expect(story(page).getByText("She leans close.")).toBeVisible();
	await page.getByRole("button", { name: "Memories" }).click();
	const memories = page.getByRole("complementary", { name: "Memories" });
	await expect(memories.getByText("Theodora hid the brass key under the third map.")).toBeVisible({ timeout: 15_000 });
	await expect(memories.getByText("Theodora fears the dark.")).toHaveCount(0);

	await send(page, "Show me.");
	await expect(story(page).getByText("She taps the map twice.")).toBeVisible();
	const prompt = JSON.stringify((await llm.log()).calls.filter((entry) => entry.kind === "chat").at(-1)!.body.messages);
	expect(prompt).toContain("Theodora hid the brass key under the third map.");
	expect(prompt).not.toContain("Theodora fears the dark.");
});
