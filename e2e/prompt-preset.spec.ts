import { test, expect } from "./fixtures";

test("a drafted block name titles its row before the preset is saved", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Prompt Presets" }).click();
	const contents = page.getByRole("region", { name: "Preset contents" });
	await contents.getByRole("button", { name: "Add block" }).click();
	await page.getByRole("menuitem", { name: "New custom instruction" }).click();
	const editor = page.getByRole("dialog", { name: "Edit prompt block" });
	await expect(editor.getByLabel("Name")).toHaveValue("Instruction");
	await editor.getByLabel("Name").fill("Tone guide");
	await editor.getByRole("button", { name: "Done" }).click();
	const row = contents.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Tone guide" }) });
	await expect(row.getByText("Unsaved")).toBeVisible();

	await row.getByRole("button", { name: "Edit Tone guide" }).click();
	await editor.getByRole("button", { name: "Cancel" }).click();
	await expect(contents.getByRole("heading", { name: "Instruction", exact: true })).toBeVisible();
	await expect(contents.getByRole("heading", { name: "Tone guide" })).toHaveCount(0);
});

test("a Lore block above Chat history is labelled until it moves below it", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Prompt Presets" }).click();
	const contents = page.getByRole("region", { name: "Preset contents" });
	const lore = contents.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Lore", exact: true }) });
	const editor = page.getByRole("dialog", { name: "Lore" });
	const titles = contents.getByRole("listitem").getByRole("heading");
	const memory = contents.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Memory", exact: true }) });
	await expect(titles.nth(7)).toHaveText("Lore");
	await expect(titles.nth(9)).toHaveText("Chat history");
	await expect(lore.getByText("Breaks cache")).toBeVisible();
	await expect(memory.getByText("Breaks cache")).toBeVisible();

	await lore.getByRole("button", { name: "Edit Lore" }).click();
	await editor.getByRole("button", { name: "Move below Chat history" }).click();
	await expect(titles.nth(8)).toHaveText("Chat history");
	await expect(titles.nth(9)).toHaveText("Lore");
	await expect(lore.getByText("Breaks cache")).toHaveCount(0);
	await expect(memory.getByText("Breaks cache")).toBeVisible();
});
