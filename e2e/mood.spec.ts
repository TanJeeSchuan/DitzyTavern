import type { Page } from "@playwright/test";
import { test, expect, selectBoxDecisionModel, insertBox, send, story } from "./fixtures";

const moods = ["not clear", "calm", "warm", "playful", "tense", "sad", "eerie"];
const mood = (passage: string | undefined, selected: string) => ({
	passage, match: ["What mood does"],
	answer: { type: "choice" as const, choice: selected, probabilities: Object.fromEntries(moods.map((label) => [label, label === selected ? 0.9 : 0.1 / (moods.length - 1)])) },
});

const preview = (page: Page) => page.getByRole("complementary", { name: "Prompt Plan preview" });

const moodLine = async (page: Page, text: string) => {
	const composer = page.getByRole("textbox", { name: "Message draft" });
	await expect(composer).toHaveAttribute("contenteditable", "true");
	await composer.fill(text);
	await page.getByRole("button", { name: "Generate Variant" }).click();
	await preview(page).getByText(/^Mood ·/).click();
	return preview(page).getByRole("textbox").filter({ hasText: "Scene mood:" });
};

const dockTab = (page: Page) => page.getByRole("button", { name: /^Mood: / });

test("the Mood follows digested passages, a swipe and a Writer override, and an unclear passage keeps it", async ({ page, request, llm }) => {
	await selectBoxDecisionModel(request, "mood");
	await llm.decisions(
		mood("The storm breaks", "tense"),
		mood("Snow drifts", "calm"),
		mood(undefined, "not clear"),
	);
	await llm.chat(
		{ chunks: ["The storm breaks over the tower at dusk."] },
		{ chunks: ["Snow drifts against the shutters."] },
		{ chunks: ["She lights the lamp."] },
	);
	await page.goto("/");
	await insertBox(page, "Mood");
	await page.getByRole("button", { name: "Mood", exact: true }).click();
	const window = page.getByRole("dialog", { name: "Mood" });
	await window.getByRole("button", { name: "Minimize Mood" }).click();

	await send(page, "Wait out the night.");
	await expect(story(page).getByText("The storm breaks")).toBeVisible();
	await expect(dockTab(page)).toHaveText("Mood: 😬 tense", { timeout: 15_000 });

	const reply = story(page).locator("article").nth(await story(page).locator("article").count() - 1);
	await reply.getByRole("button", { name: "New Swipe" }).click();
	await expect(preview(page).getByText(/^Mood ·/)).toHaveCount(0);
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(reply.getByText("Snow drifts")).toBeVisible();
	await expect(dockTab(page)).toHaveText("Mood: 😌 calm", { timeout: 15_000 });
	await expect(await moodLine(page, "Look outside.")).toHaveText("Scene mood: calm");
	await preview(page).getByRole("button", { name: "Cancel" }).click();

	await dockTab(page).click();
	const passage = window.getByRole("listitem").filter({ hasText: "Snow drifts" });
	await passage.hover();
	await passage.getByRole("button", { name: "Edit" }).click();
	await passage.getByRole("combobox", { name: "Mood" }).click();
	await page.getByRole("option", { name: "👻 Eerie" }).click();
	await passage.getByRole("button", { name: "Save override" }).click();
	await expect(passage).toContainText("Overridden");
	await expect(passage).toContainText("👻 Eerie");
	await window.getByRole("button", { name: "Minimize Mood" }).click();
	await expect(dockTab(page)).toHaveText("Mood: 👻 eerie");

	await expect(await moodLine(page, "Look outside.")).toHaveText("Scene mood: eerie");
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(story(page).getByText("She lights the lamp.")).toBeVisible();
	await dockTab(page).click();
	await expect(window.getByRole("listitem").filter({ hasText: "She lights the lamp." })).toContainText("❔ Not clear", { timeout: 15_000 });
	await window.getByRole("button", { name: "Minimize Mood" }).click();
	await expect(dockTab(page)).toHaveText("Mood: 👻 eerie");
	await expect(await moodLine(page, "And now?")).toHaveText("Scene mood: eerie");
	await preview(page).getByRole("button", { name: "Cancel" }).click();
});
