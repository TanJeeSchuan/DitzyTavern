import { test, expect, insertBox, openBoxes as manager, closeBoxes } from "../../../e2e/fixtures";

test("a disabled World Clock keeps its window and saved setup, which stays editable, and removing resets it", async ({ page }) => {
	await page.goto("/");
	await insertBox(page, "World Clock");
	await page.getByRole("button", { name: "World Clock", exact: true }).click();
	const window = page.getByRole("dialog", { name: "World Clock" });
	await window.getByRole("textbox", { name: "Era" }).fill("BE");

	let boxes = await manager(page);
	await page.getByRole("dialog", { name: "Unsaved changes" }).getByRole("button", { name: "Save and leave" }).click();
	await boxes.getByRole("switch", { name: "World Clock in this Chat" }).click();
	await expect(boxes.getByRole("listitem").filter({ hasText: "World Clock" })).toContainText("8:00 AM");
	await closeBoxes(page);
	await expect(window).toContainText("World Clock is off in this Chat.");
	await expect(window.getByRole("textbox", { name: "Era" })).toHaveValue("BE");
	await window.getByRole("textbox", { name: "Era" }).fill("CE");
	await window.getByRole("button", { name: "Save World Clock" }).click();
	await expect(window.getByRole("button", { name: "Save World Clock" })).toBeDisabled();
	await window.getByRole("button", { name: "Turn on" }).click();
	await expect(window).not.toContainText("World Clock is off in this Chat.");
	await expect(window.getByRole("textbox", { name: "Era" })).toHaveValue("CE");

	boxes = await manager(page);
	await boxes.getByRole("button", { name: "World Clock actions" }).click();
	await page.getByRole("menuitem", { name: "Remove from Chat…" }).click();
	await page.getByRole("dialog", { name: "Remove World Clock?" }).getByRole("button", { name: "Remove" }).click();
	await expect(window).toHaveCount(0);
	await expect(page.getByRole("button", { name: "World Clock", exact: true })).toHaveCount(0);
	await insertBox(page, "World Clock");
	await page.getByRole("button", { name: "World Clock", exact: true }).click();
	await expect(window.getByRole("textbox", { name: "Era" })).toHaveValue("AD");
});
