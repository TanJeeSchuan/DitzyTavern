import type { APIRequestContext } from "@playwright/test";
import { test, expect, enableDecisionModels, insertBox, send, story, openBoxes, closeBoxes } from "./fixtures";
import type { DecisionRule } from "./protocol";
import { isChatModelCall } from "./protocol";

const enableMemory = async (request: APIRequestContext) => {
	const { profiles } = await (await request.get("/api/connection-settings")).json();
	const profileId = (apiFormat: string) => profiles.find((profile: { apiFormat: string }) => profile.apiFormat === apiFormat).id;
	const { revision, ...settings } = await (await request.get("/api/boxes/memory/settings")).json();
	await request.post("/api/boxes/memory/settings/commands", { data: {
		...settings, expectedRevision: revision,
		extractionProfileId: profileId("chat-completions"), extractionModel: "e2e-model",
		embeddingProfileId: profileId("embeddings"), embeddingModel: "e2e-embedding",
	} });
};

const choice = (selected: string, labels: string[]) => ({
	type: "choice" as const, choice: selected, confidence: 0.9,
	probabilities: Object.fromEntries(labels.map((label) => [label, label === selected ? 0.9 : 0.1 / (labels.length - 1)])),
});

const judge = (claim: string, verdict: { support: string; attribution: string; usefulness: string }): DecisionRule[] => [
	{ match: [claim, "How does `source` relate to `memory.claim`?"], answer: choice(verdict.support, ["supported", "contradicted", "not_established"]) },
	{ match: [claim, "is `memory.attribution` the one who"], answer: choice(verdict.attribution, ["correct", "misattributed", "unclear"]) },
	{ match: [claim, "still matter to the story"], answer: choice(verdict.usefulness, ["retain", "omit"]) },
];

test("a reply becomes an attributed Memory that the next Generation recalls", async ({ page, request, llm }) => {
	await enableDecisionModels(request);
	await llm.embeddings("brass key", "Where is the key?", "Show me.");
	await llm.memories(
		{ claim: "Theodora hid the brass key under the third map.", attribution: "Theodora Kline", people: ["Theodora Kline"], excerpt: "I hid the brass key under the third map." },
		{ claim: "Theodora fears the dark.", attribution: "Theodora Kline", people: ["Theodora Kline"], excerpt: "The dark presses against the dome." },
	);
	await llm.decisions(
		...judge("brass key", { support: "supported", attribution: "correct", usefulness: "retain" }),
		...judge("fears the dark", { support: "not_established", attribution: "correct", usefulness: "retain" }),
		{ match: ["brass key", "How much does `memory` help"], answer: { type: "score", score: 3, legend: {}, probabilities: { 0: 0.02, 1: 0.03, 2: 0.05, 3: 0.9 }, confidence: 0.9 } },
	);
	await llm.chat(
		{ chunks: ["She leans close. \"I hid the brass key under the third map. The dark presses against the dome.\""] },
		{ chunks: ["She taps the map twice."] },
	);
	await enableMemory(request);

	await page.goto("/");
	await send(page, "Where is the key?");
	await expect(story(page).getByText("She leans close.")).toBeVisible();
	await page.getByRole("button", { name: "Memories" }).click();
	const memories = page.getByRole("complementary", { name: "Memories" });
	await expect(memories.getByText("Theodora hid the brass key under the third map.")).toBeVisible({ timeout: 15_000 });
	await expect(memories.getByText("Theodora fears the dark.")).toHaveCount(0);

	await send(page, "Show me.");
	await expect(story(page).getByText("She taps the map twice.")).toBeVisible();
	const prompt = JSON.stringify((await llm.log()).calls.filter(isChatModelCall).at(-1)!.body.messages);
	expect(prompt).toContain("Theodora hid the brass key under the third map.");
	expect(prompt).not.toContain("Theodora fears the dark.");

	await page.getByRole("group", { name: "Chat tools" }).getByRole("button", { name: "Memories", exact: true }).click();
	await expect(memories).toBeVisible();
	await openBoxes(page);
	await page.getByRole("switch", { name: "Memory in this Chat" }).click();
	await closeBoxes(page);
	await page.getByRole("group", { name: "Chat tools" }).getByRole("button", { name: "Memories", exact: true }).click();
	await expect(memories).toContainText("Memory is off in this Chat.");
	await expect(memories.getByText("Theodora hid the brass key under the third map.")).toBeVisible();
	await memories.getByRole("button", { name: "Close Memories", exact: true }).click();
	await page.getByRole("group", { name: "Chat tools" }).getByRole("button", { name: "Memories", exact: true }).click();
	await expect(memories.getByText("Theodora hid the brass key under the third map.")).toBeVisible();
});

test("a Message's Memories action remembers it on demand", async ({ page, request, llm }) => {
	await enableDecisionModels(request);
	await llm.embeddings("lantern");
	await llm.memories({ claim: "Theodora keeps the lantern lit all night.", attribution: "Theodora Kline", people: ["Theodora Kline"], excerpt: "I keep the lantern lit all night." });
	await llm.decisions(...judge("lantern", { support: "supported", attribution: "correct", usefulness: "retain" }));
	await llm.chat({ chunks: ["She nods. \"I keep the lantern lit all night.\""] }, { chunks: ["She turns back to the map."] });

	await page.goto("/");
	await openBoxes(page);
	await page.getByRole("switch", { name: "Memory in this Chat" }).click();
	await closeBoxes(page);
	await send(page, "Why is the light on?");
	const reply = story(page).locator("article", { hasText: "She nods." });
	await expect(reply).toBeVisible();
	await send(page, "Go on.");
	await expect(story(page).getByText("She turns back to the map.")).toBeVisible();
	await enableMemory(request);
	await insertBox(page, "Memory");

	await reply.hover();
	await reply.getByRole("button", { name: "Memories" }).click();
	const memories = page.getByRole("complementary", { name: "Memories" });
	await memories.getByRole("button", { name: "Remember this Message" }).click();
	await expect(memories.getByText("Theodora keeps the lantern lit all night.")).toBeVisible({ timeout: 15_000 });
});

test("a corrected Memory stays the writer's until reset brings back the remembered one", async ({ page, request, llm }) => {
	await enableDecisionModels(request);
	await llm.embeddings("brass key");
	await llm.memories({ claim: "Theodora hid the brass key under the third map.", attribution: "Theodora Kline", people: ["Theodora Kline"], excerpt: "I hid the brass key under the third map." });
	await llm.decisions(...judge("brass key", { support: "supported", attribution: "correct", usefulness: "retain" }));
	await llm.chat({ chunks: ["She leans close. \"I hid the brass key under the third map.\""] });
	await enableMemory(request);

	await page.goto("/");
	await send(page, "Where is the key?");
	await expect(story(page).getByText("She leans close.")).toBeVisible();
	await page.getByRole("button", { name: "Memories" }).click();
	const memories = page.getByRole("complementary", { name: "Memories" });
	const remembered = memories.getByText("Theodora hid the brass key under the third map.");
	await expect(remembered).toBeVisible({ timeout: 15_000 });
	const claim = memories.locator("article", { hasText: "Theodora hid the brass key under the third map." });
	await claim.hover();
	await claim.getByRole("button", { name: "Edit Memory" }).click();
	await memories.getByRole("textbox", { name: "Memory" }).fill("Theodora moved the brass key to the attic.");
	await memories.getByRole("button", { name: "Save" }).click();
	const corrected = memories.locator("article", { hasText: "Theodora moved the brass key to the attic." });
	await expect(corrected).toContainText("Edited");
	await expect(remembered).toHaveCount(0);

	await corrected.getByRole("button", { name: / · #\d+$/ }).click();
	await memories.getByRole("button", { name: "Reset corrections…" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Reset corrections" }).click();
	await expect(remembered).toBeVisible({ timeout: 15_000 });
	await expect(corrected).toHaveCount(0);
});
