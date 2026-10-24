import { test, expect, insertBox, openBoxes, closeBoxes } from "./fixtures";

test("the narrow Chat title menu opens the Box inspector and returns to the story", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	await openBoxes(page);
	await page.getByRole("switch", { name: "Memory in this Chat" }).click();
	await closeBoxes(page);
	await page.getByRole("heading", { level: 1 }).getByRole("button").click();
	await page.getByRole("menuitem", { name: "Memories", exact: true }).click();
	const inspector = page.getByRole("complementary", { name: "Memories" });
	await expect(inspector).toBeVisible();
	await inspector.getByRole("button", { name: "Back to Chat" }).click();
	await expect(inspector).toHaveCount(0);
	await expect(page.getByRole("textbox", { name: "Message draft" })).toBeVisible();
});

test("removing an inspected Box closes it without reopening on reinsertion", async ({ page }) => {
	await page.goto("/");
	const tools = page.getByRole("group", { name: "Chat tools" });
	const opener = tools.getByRole("button", { name: "Memories", exact: true });
	const inspector = page.getByRole("complementary", { name: "Memories" });
	await opener.click();
	await expect(inspector).toBeVisible();
	await openBoxes(page);
	await page.getByRole("button", { name: "Memory actions", exact: true }).click();
	await page.getByRole("menuitem", { name: "Remove from Chat…", exact: true }).click();
	await page.getByRole("dialog", { name: "Remove Memory?" }).getByRole("button", { name: "Remove", exact: true }).click();
	await expect(inspector).toHaveCount(0);
	await expect(opener).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Add Memory", exact: true })).toBeVisible();
	await insertBox(page, "Memory");
	await expect(opener).toBeVisible();
	await expect(inspector).toHaveCount(0);
	await opener.click();
	await expect(inspector).toBeVisible();
});
