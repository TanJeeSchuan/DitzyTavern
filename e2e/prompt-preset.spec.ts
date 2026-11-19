import { Value } from "@sinclair/typebox/value";
import { promptPresetBlockPatchesBody } from "../src/shared/contract/prompt-preset";
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

test("text typed during a Prompt Preset save survives its refresh", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Prompt Presets" }).click();
	const contents = page.getByRole("region", { name: "Preset contents" });
	const openEditor = contents.getByRole("button", { name: "Edit Author Note" });
	const editor = page.getByRole("dialog", { name: "Author Note" });
	const instructions = editor.getByRole("textbox", { name: "Instructions" });
	const save = page.getByRole("button", { name: "Save", exact: true });

	await openEditor.click();
	await instructions.fill("First version.");
	await editor.getByRole("button", { name: "Done" }).click();
	const refreshing = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	await page.route("**/api/conversations/*/prompt-preset", async (route) => {
		refreshing.resolve();
		await release.promise;
		await route.continue();
	}, { times: 1 });

	try {
		await save.click();
		await refreshing.promise;
		await openEditor.click();
		await instructions.fill("Second version, typed during the save.");
		await editor.getByRole("button", { name: "Done" }).click();
	} finally {
		release.resolve();
	}

	await expect(save).toBeEnabled();
	await openEditor.click();
	await expect(instructions).toHaveValue("Second version, typed during the save.");
	await editor.getByRole("button", { name: "Done" }).click();
	await save.click();
	await expect(page.locator(".save-footer").getByRole("status")).toHaveText("Saved");
});

test("Save and leave keeps a draft overwritten by another Prompt Preset editor", async ({ page, request }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Prompt Presets" }).click();
	const contents = page.getByRole("region", { name: "Preset contents" });
	const openEditor = contents.getByRole("button", { name: "Edit Author Note" });
	const editor = page.getByRole("dialog", { name: "Author Note" });
	const instructions = editor.getByRole("textbox", { name: "Instructions" });
	await openEditor.click();
	await instructions.fill("My draft.");
	await editor.getByRole("button", { name: "Done" }).click();

	await page.route("**/api/prompt-presets/*/blocks/patches", async (route) => {
		const saved = await route.fetch();
		await expect(saved).toBeOK();
		const { patches: [patch] } = Value.Parse(promptPresetBlockPatchesBody, route.request().postDataJSON());
		if (patch?.type !== "content") throw new Error("Expected an Author Note content patch.");
		const overwrite = await request.post(route.request().url(), { data: { patches: [{ ...patch, content: "Their draft." }] } });
		await expect(overwrite).toBeOK();
		await route.fulfill({ response: saved });
	}, { times: 1 });

	await page.getByRole("button", { name: "Close Prompt Presets" }).click();
	const guard = page.getByRole("dialog", { name: "Unsaved changes" });
	await guard.getByRole("button", { name: "Save and leave" }).click();
	await expect(guard.getByRole("alert")).toBeVisible();
	await guard.getByRole("button", { name: "Keep editing" }).click();
	await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
	await openEditor.click();
	await expect(instructions).toHaveValue("My draft.");
});

test.describe("failed Prompt Preset reads", () => {
	test.use({ allowedBrowserErrors: /status of 503/ });

	test("a failed recipe read after switching presets hides the old editor", async ({ page, request }) => {
		const imported = await request.post("/api/prompt-presets/import", { data: { name: "Other preset", slots: [] } });
		await expect(imported).toBeOK();
		await page.goto("/");
		await page.getByRole("button", { name: "Prompt Presets" }).click();
		const contents = page.getByRole("region", { name: "Preset contents" });
		await expect(contents.getByRole("button", { name: "Edit Author Note" })).toBeEnabled();
		await page.route("**/api/conversations/*/prompt-preset", (route) => route.fulfill({ status: 503 }));
		await page.getByRole("combobox", { name: "Preset for this Chat" }).click();
		await Promise.all([
			page.waitForResponse((response) => response.url().endsWith("/prompt-preset") && response.status() === 503),
			page.getByRole("option", { name: "Other preset", exact: true }).click(),
		]);

		await expect(page.getByText("The Prompt Preset library could not be loaded.")).toBeVisible();
		await expect(contents).toHaveCount(0);
	});
});

test("Back to Paint asks before discarding Paint Preset edits", async ({ page }) => {
	await page.goto("/");
	await page.locator("form.composer").getByRole("button", { name: "Paint", exact: true }).click();
	await page.getByRole("button", { name: "Edit Paint Preset", exact: true }).click();
	const preset = page.getByRole("complementary", { name: "Paint Preset", exact: true });
	await preset.getByRole("button", { name: "Edit Brief instruction", exact: true }).click();
	const block = page.getByRole("dialog", { name: "Brief instruction", exact: true });
	await block.getByRole("textbox", { name: "Brief instruction text" }).fill("Use natural light.");
	await block.getByRole("button", { name: "Done" }).click();
	await preset.getByRole("button", { name: "Back to Paint" }).click();
	const guard = page.getByRole("dialog", { name: "Unsaved changes" });
	await guard.getByRole("button", { name: "Keep editing" }).click();
	await expect(preset.getByText("Unsaved", { exact: true })).toBeVisible();
	await preset.getByRole("button", { name: "Back to Paint" }).click();
	await guard.getByRole("button", { name: "Discard" }).click();
	await expect(page.getByRole("complementary", { name: "Paint", exact: true })).toBeVisible();
});
