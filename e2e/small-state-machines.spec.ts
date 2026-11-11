import { test, expect } from "./fixtures";
import { emptyPromptChannels } from "../src/shared/definition";

test.use({ allowedBrowserErrors: /status of 422/ });

test("a refused Cast removal keeps the Participant editor open", async ({ page, request }) => {
	const { activeChatId } = await (await request.get("/api/workspace")).json();
	const url = `/api/conversations/${activeChatId}`;
	const { revision } = await (await request.get(url)).json();
	await request.post(`${url}/commands`, { data: { expectedRevision: revision, action: {
		type: "add-participant", definition: { name: "Guest", prompt: emptyPromptChannels(), sendAppearanceImages: true, openings: [] },
	} } });
	await page.goto("/");
	await page.getByRole("button", { name: "Characters", exact: true }).click();
	await page.getByRole("button", { name: "Guest", exact: true }).click();
	await page.route(`**${url}/commands`, (route) => route.fulfill({ status: 422, json: { outcome: "invalid", reason: "Removal refused for this test." } }));
	await page.getByRole("button", { name: "Actions for Guest" }).click();
	await page.getByRole("menuitem", { name: "Remove from Chat" }).click();
	await page.getByRole("dialog").getByRole("button", { name: /Remove/ }).click();
	await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Guest");
	await expect(page.getByText("Removal refused for this test.")).toBeVisible();
});

test("Escape cannot dismiss a prompt save that is still running", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Prompt Presets" }).click();
	await page.getByRole("button", { name: "Edit Author Note" }).click();
	const editor = page.getByRole("dialog", { name: "Author Note" });
	await editor.getByRole("textbox", { name: "Instructions" }).fill("Keep the note concise.");
	await editor.getByRole("button", { name: "Done" }).click();
	await page.getByRole("button", { name: "Close Prompt Presets" }).click();
	const dialog = page.getByRole("dialog", { name: "Unsaved block edit" });
	const held = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	await page.route("**/api/prompt-presets/*/blocks/patches", async (route) => { held.resolve(); await release.promise; await route.continue(); });
	try {
		await dialog.getByRole("button", { name: "Save and close" }).click();
		await held.promise;
		await expect(dialog.getByRole("button", { name: "Keep editing" })).toBeDisabled();
		await page.keyboard.press("Escape");
		await expect(dialog).toBeVisible();
	} finally { release.resolve(); }
	await expect(dialog).toBeHidden();
});

test("a Portrait upload keeps its dialog and editor locked until it settles", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Characters", exact: true }).click();
	await page.getByRole("button", { name: /Theodora Kline maps coastlines/ }).first().click();
	await page.getByRole("button", { name: /(?:Add a|Edit the) Portrait/ }).click();
	const dialog = page.getByRole("dialog", { name: "Portrait", exact: true });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	await page.route("**/api/images", async (route) => { entered.resolve(); await release.promise; await route.continue(); });
	try {
		await dialog.getByLabel("Portrait file").setInputFiles({ name: "portrait.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1EAAAAASUVORK5CYII=", "base64") });
		await entered.promise;
		await expect(dialog.getByRole("button", { name: "Done", exact: true })).toBeDisabled();
		await page.keyboard.press("Escape");
		await expect(dialog).toBeVisible();
		await expect(dialog.getByLabel("Portrait file")).toBeDisabled();
	} finally { release.resolve(); }
	await expect(dialog.getByRole("button", { name: "Done", exact: true })).toBeEnabled();
	await expect(dialog.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
});
