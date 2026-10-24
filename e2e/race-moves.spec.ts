import type { Page } from "@playwright/test";
import { test, expect, story, insertBox } from "./fixtures";

const raceItem = async (page: Page) => {
	const preview = page.getByRole("complementary", { name: "Prompt Plan preview" });
	await preview.getByText(/^Race ·/).click();
	return preview.getByRole("textbox", { name: /^box:race block/ }).innerText();
};

test("Moves resolve in the next Stretch, alone or with text, replay on a swipe, and fizzle when Auto takes over", async ({ page, llm }) => {
	test.setTimeout(60_000);
	await llm.chat(...Array.from({ length: 4 }, (_, index) => ({ chunks: [`Race passage ${index + 1}.`] })));
	await page.goto("/");
	await insertBox(page, "Race");
	await page.getByRole("button", { name: "Race", exact: true }).click();
	const window = page.getByRole("dialog", { name: "Race", exact: true });
	await window.getByRole("spinbutton", { name: "Distance (m)" }).fill("800");
	await window.getByRole("button", { name: "Fill field" }).click();
	await window.getByRole("radiogroup", { name: "Auto mode" }).getByRole("radio", { name: "Off" }).click();
	await window.getByRole("button", { name: "Start race" }).click();
	const moves = window.getByRole("region", { name: "Race Moves" });
	await window.getByRole("combobox", { name: "Order Runner" }).click();
	const option = page.getByRole("option").nth(1);
	const runner = await option.innerText();
	await option.click();
	let passage = 0;
	const accept = async () => {
		const number = ++passage;
		await page.getByRole("button", { name: "Send exact plan" }).click();
		await expect(story(page).getByText(`Race passage ${number}.`, { exact: true })).toBeVisible();
	};
	const composer = page.locator("form.composer");

	// @approved A Moves-only turn: the second gate trails the first, so Overtake is offered, and Conserve becomes legal once it is staged.
	await expect(moves.getByRole("button", { name: /Conserve/ })).toHaveCount(0);
	await moves.getByRole("button", { name: /Overtake/ }).click();
	await moves.getByRole("button", { name: /Conserve/ }).click();
	await expect(composer.getByRole("list", { name: "Moves" }).getByRole("listitem")).toHaveText([`Overtake · ${runner}`, `Conserve · ${runner}`]);
	await page.getByRole("button", { name: "Generate Variant" }).click();
	const first = await raceItem(page);
	expect(first).toContain("Stretch 1: 0–400 m");
	expect(first).toMatch(new RegExp(`Overtake · ${runner}: (succeeds|fizzles)`));
	expect(first).toContain(`Conserve · ${runner}: succeeds`);
	// @approved While the read of the new revision loads, the offers still read the state before this Stretch, so none of them stages a Move.
	const read = Promise.withResolvers<void>();
	await page.route("**/api/conversations/*/boxes/race", async (route) => { await read.promise; await route.fallback(); });
	await accept();
	await expect(page.getByRole("textbox", { name: "Message draft" })).toHaveAttribute("contenteditable", "true");
	await expect(moves.getByRole("button", { name: /Hold/ })).toBeDisabled();
	read.resolve();
	await expect(moves.getByRole("button", { name: /Hold/ })).toBeEnabled();
	const human = story(page).locator("article").nth(-2);
	await expect(human.getByRole("list", { name: "Moves" }).getByRole("listitem")).toHaveCount(2);
	await expect(composer.getByRole("list", { name: "Moves" })).toHaveCount(0);

	// @approved Moves with text: history shows the earlier Moves' intent, and only this Stretch reports outcomes.
	await moves.getByRole("button", { name: /Spurt/ }).click();
	await page.getByRole("textbox", { name: "Message draft" }).fill("Go now.");
	await page.getByRole("button", { name: "Generate Variant" }).click();
	const second = await raceItem(page);
	expect(second).toContain("Stretch 2: 400–500 m");
	expect(second).toMatch(new RegExp(`Spurt · ${runner}: (succeeds|fizzles)`));
	expect(second).not.toContain("Overtake");
	await accept();
	const [, sent] = (await llm.log()).calls.filter((call) => call.kind === "chat");
	expect(JSON.stringify(sent)).toContain(`(Race Move: ${runner} tries to overtake.)`);
	expect(JSON.stringify(sent)).not.toContain(`Overtake · ${runner}:`);

	// @approved A swipe reuses its Message's Moves and seed, so the Stretch is the same.
	const reply = story(page).locator("article").last();
	await reply.getByRole("button", { name: "New Swipe" }).click();
	expect(await raceItem(page)).toBe(second);
	await accept();

	// @approved A Move staged before Auto took over is still sent and fizzles, narrated in the Stretch.
	await moves.getByRole("button", { name: /Conserve/ }).click();
	await window.getByRole("radiogroup", { name: "Auto mode" }).getByRole("radio", { name: "On" }).click();
	await window.getByRole("button", { name: "Save setup" }).click();
	await expect(moves.getByText("Moves are off while Auto mode runs.")).toBeVisible();
	await page.getByRole("textbox", { name: "Message draft" }).fill("Hold steady.");
	await page.getByRole("button", { name: "Generate Variant" }).click();
	const fizzled = await raceItem(page);
	expect(fizzled).toContain("Stretch 3: 500–600 m");
	expect(fizzled).toContain(`Conserve · ${runner}: fizzles. Moves are off while Auto mode runs.`);
	await accept();
});
