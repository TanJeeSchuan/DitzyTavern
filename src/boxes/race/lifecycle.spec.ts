import type { Page } from "@playwright/test";
import { test, expect, insertBox, story, openBoxes as manager } from "../../../e2e/fixtures";

const generate = async (page: Page, text: string) => {
	const composer = page.getByRole("textbox", { name: "Message draft" });
	await expect(composer).toHaveAttribute("contenteditable", "true");
	await composer.fill(text);
	await page.getByRole("button", { name: "Generate Variant" }).click();
	return page.getByRole("complementary", { name: "Prompt Plan preview" });
};

const sendPlan = async (page: Page, reply: string) => {
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(story(page).getByText(reply, { exact: true })).toBeVisible();
};

test("removing the Race after a Stretch keeps the story and its Moves, which reach the model as their labels", async ({ page, llm }) => {
	await llm.chat({ chunks: ["Race passage 1."] }, { chunks: ["The crowd disperses."] });
	await page.goto("/");
	await insertBox(page, "Race");
	await page.getByRole("button", { name: "Race", exact: true }).click();
	const window = page.getByRole("dialog", { name: "Race", exact: true });
	await window.getByRole("spinbutton", { name: "Distance (m)" }).fill("800");
	await window.getByRole("button", { name: "Fill field" }).click();
	await window.getByRole("radiogroup", { name: "Auto mode" }).getByRole("radio", { name: "Off" }).click();
	await window.getByRole("button", { name: "Start race" }).click();
	await window.getByRole("combobox", { name: "Order Runner" }).click();
	const option = page.getByRole("option").nth(1);
	const runner = await option.innerText();
	await option.click();
	await window.getByRole("region", { name: "Race Moves" }).getByRole("button", { name: /Overtake/ }).click();
	await page.getByRole("button", { name: "Generate Variant" }).click();
	await sendPlan(page, "Race passage 1.");
	const human = story(page).locator("article").nth(-2);
	const chips = human.getByRole("list", { name: "Race Moves" }).getByRole("listitem");
	await expect(chips).toHaveText([`Overtake · ${runner}`]);

	const boxes = await manager(page);
	await boxes.getByRole("button", { name: "Race actions" }).click();
	await page.getByRole("menuitem", { name: "Remove from Chat…" }).click();
	await page.getByRole("dialog", { name: "Remove Race?" }).getByRole("button", { name: "Remove" }).click();
	await expect(window).toHaveCount(0);
	await expect(story(page).getByText("Race passage 1.")).toBeVisible();
	await expect(chips).toHaveText([`Overtake · ${runner}`]);

	await expect((await generate(page, "Walk home.")).getByText(/^Race ·/)).toHaveCount(0);
	await sendPlan(page, "The crowd disperses.");
	const sent = JSON.stringify((await llm.log()).calls.filter((call) => call.kind === "chat").at(-1));
	expect(sent).toContain(`Overtake · ${runner}`);
	expect(sent).not.toContain("(Race Move:");
});
