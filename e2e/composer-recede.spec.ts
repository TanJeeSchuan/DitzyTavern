import { test, expect, send, story } from "./fixtures";

test("the composer recedes while reading back, returns on Write, and comes back at the latest Message", async ({ page, llm }) => {
	await llm.chat({ chunks: [Array.from({ length: 40 }, (_, line) => `Line ${line} of a long reply.`).join("\n\n")] });
	await page.goto("/");
	await send(page, "Tell me everything.");
	await expect(story(page).getByText("Line 39 of a long reply.")).toBeVisible();
	const composer = page.locator("form.composer");
	const write = page.getByRole("button", { name: /^Write/ });
	const scroller = story(page).locator(".story-scroll");
	await scroller.evaluate((element) => element.scrollTo({ top: 0, behavior: "instant" }));
	await expect(composer).toHaveAttribute("data-receded", "true");
	await expect(write).toBeVisible();

	await write.click();
	await expect(composer).toHaveAttribute("data-receded", "false");
	await expect(page.getByRole("textbox", { name: "Message draft" })).toBeFocused();
	await story(page).getByText("Line 0 of a long reply.").click();
	await expect(composer).toHaveAttribute("data-receded", "true");

	await scroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: "instant" }));
	await expect(composer).toHaveAttribute("data-receded", "false");
	await expect(write).toBeHidden();
});
