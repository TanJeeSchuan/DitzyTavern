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
