import type { Page } from "@playwright/test";
import { test, expect, story } from "./fixtures";

const raceItem = async (page: Page) => {
	const preview = page.getByRole("complementary", { name: "Prompt Plan preview" });
	await preview.getByText(/^Race ·/).click();
	return preview.getByRole("textbox").filter({ hasText: "Narrate" }).innerText();
};

// @approved The short custom course exercises every terminal step without a long generated conversation.
test("an Auto race retains swiped outcomes, re-rolls a Stretch, and ends after Results", async ({ page, llm }) => {
	test.setTimeout(60_000);
	await llm.chat(...Array.from({ length: 12 }, (_, index) => ({ chunks: [`Race passage ${index + 1}.`] })));
	await page.goto("/");
	await page.getByRole("button", { name: "Race", exact: true }).click();
	const window = page.getByRole("dialog", { name: "Race", exact: true });
	await window.getByRole("spinbutton", { name: "Distance (m)" }).fill("800");
	await window.getByRole("button", { name: "Fill field" }).click();
	await expect(window.getByRole("list", { name: "Race field" }).getByRole("listitem")).toHaveCount(8);
	await window.getByRole("button", { name: "Start race" }).click();
	await expect(window.getByRole("button", { name: "New race" })).toBeVisible();
	await window.getByRole("button", { name: "Minimize Race" }).click();
	const dock = page.getByRole("button", { name: /^Race: / });
	let passage = 0;
	const accept = async () => {
		const number = ++passage;
		await page.getByRole("button", { name: "Send exact plan" }).click();
		await expect(story(page).getByText(`Race passage ${number}.`, { exact: true })).toBeVisible();
	};
	const continueRace = async () => {
		await story(page).locator("article").last().getByRole("button", { name: /^Continue/ }).click();
		return raceItem(page);
	};
	await page.getByRole("textbox", { name: "Message draft" }).fill("Start the race.");
	await page.getByRole("button", { name: "Generate Variant" }).click();
	expect(await raceItem(page)).toContain("Stretch 1: 0–400 m");
	await accept();
	const first = story(page).locator("article").last();
	const firstId = await first.getAttribute("data-message-id");
	const second = await continueRace();
	expect(second).toContain("Stretch 2: 400–500 m");
	await accept();
	const reply = story(page).locator("article").last();
	await reply.getByRole("button", { name: "New Swipe" }).click();
	expect(await raceItem(page)).toBe(second);
	await accept();
	await reply.hover();
	await reply.getByRole("button", { name: "Re-roll" }).click();
	const rerolled = await raceItem(page);
	expect(rerolled).toContain("Stretch 2: 400–500 m");
	expect(rerolled).not.toBe(second);
	await accept();
	await expect(dock).toContainText("500m");

	// @approved Rewriting an earlier Stretch must leave the later resolved Stretch in the fold.
	const earlier = story(page).locator(`article[data-message-id="${firstId}"]`);
	await earlier.hover();
	await earlier.getByRole("button", { name: "Re-roll" }).click();
	expect(await raceItem(page)).toContain("Stretch 1: 0–400 m");
	await accept();
	await expect(dock).toContainText("500m");
	await reply.hover();
	await reply.getByRole("button", { name: "New Swipe", exact: true }).first().click();
	const reconciled = await raceItem(page);
	expect(reconciled).toContain("Stretch 2: 400–500 m");
	expect(reconciled).not.toBe(rerolled);
	await accept();
	await reply.hover();
	await reply.getByRole("button", { name: "New Swipe", exact: true }).first().click();
	expect(await raceItem(page)).toBe(reconciled);
	await accept();
	for (const end of [600, 700, 800]) {
		expect(await continueRace()).toContain(`Do not go past ${end} m.`);
		await accept();
	}
	const results = await continueRace();
	expect(results).toContain("Results Stretch");
	expect(results).toContain("Narrate the finish.");
	expect(results).toMatch(/\+\d+\.\d{2} s/);
	await accept();
	await expect(dock).toContainText("🏁 1st");
	await reply.getByRole("button", { name: /^Continue/ }).click();
	await expect(page.getByRole("complementary", { name: "Prompt Plan preview" }).getByText(/^Race ·/)).toHaveCount(0);
	await accept();
	await dock.click();
	await window.getByRole("button", { name: "New race" }).click();
	await expect(window.getByRole("button", { name: "Fill field" })).toBeEnabled();
	await expect(window.getByRole("list", { name: "Race field" }).getByRole("listitem")).toHaveCount(0);
});
