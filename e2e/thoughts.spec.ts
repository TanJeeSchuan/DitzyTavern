import type { Page } from "@playwright/test";
import { test, expect, insertBox, story } from "./fixtures";

const generate = async (page: Page, text: string) => {
	const composer = page.getByRole("textbox", { name: "Message draft" });
	await expect(composer).toHaveAttribute("contenteditable", "true");
	await composer.fill(text);
	await page.getByRole("button", { name: "Generate Variant" }).click();
	return page.getByRole("complementary", { name: "Prompt Plan preview" });
};

test("a thought in a reply moves from the prose to the Thoughts window, follows a swipe, and is taught only while the Box is enabled", async ({ page, llm }) => {
	await llm.chat(
		{ chunks: ["Theodora smiles.\n<thought>He knows.</thought>\nShe pours the tea."] },
		{ chunks: ["Theodora frowns.\n<thought>Stay calm.</thought>"] },
		{ chunks: ["She leaves."] },
	);
	await page.goto("/");
	await insertBox(page, "Thoughts");

	const preview = await generate(page, "The night is quiet.");
	await preview.getByText(/^Thoughts ·/).click();
	await expect(preview.getByRole("textbox").filter({ hasText: "<thought>the thought</thought>" })).toHaveCount(1);
	await page.getByRole("button", { name: "Send exact plan" }).click();
	const reply = story(page).locator("article").last();
	await expect(reply.getByText("She pours the tea.")).toBeVisible();
	await expect(reply).not.toContainText("He knows.");

	await reply.getByRole("button", { name: "A thought" }).click();
	const thoughts = page.getByRole("dialog", { name: "Thoughts" }).getByRole("list", { name: "Thoughts" });
	await expect(thoughts.getByRole("listitem")).toHaveText(["Theodora KlineHe knows."]);
	await page.getByRole("dialog", { name: "Thoughts" }).getByRole("button", { name: "Minimize Thoughts" }).click();
	await expect(page.getByRole("button", { name: /^Thoughts: / })).toContainText("1 thought");

	await reply.getByLabel("New Swipe").click();
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(story(page).getByText("Theodora frowns.")).toBeVisible();
	await reply.getByRole("button", { name: "A thought" }).click();
	await expect(thoughts.getByRole("listitem")).toHaveText(["Theodora KlineStay calm."]);

	await page.getByRole("button", { name: "Boxes", exact: true }).click();
	await page.getByRole("switch", { name: "Thoughts in this Chat" }).click();
	await page.keyboard.press("Escape");
	await expect((await generate(page, "Goodnight.")).getByText(/^Thoughts ·/)).toHaveCount(0);
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(story(page).getByText("She leaves.")).toBeVisible();
});
