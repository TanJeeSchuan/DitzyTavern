import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, insertBox, story } from "./fixtures";

const attachPreset = async (page: Page, request: APIRequestContext, slots: unknown[]) => {
	await page.goto("/");
	const { preset } = await (await request.post("/api/prompt-presets/import", { data: { name: "Lean", slots: [{ reference: "history", enabled: true }, ...slots] } })).json();
	const { activeChatId } = await (await request.get("/api/workspace")).json();
	const { revision } = await (await request.get(`/api/conversations/${activeChatId}`)).json();
	const selected = await request.post(`/api/conversations/${activeChatId}/commands`, { data: { expectedRevision: revision, action: { type: "select-prompt-preset", promptPresetId: preset.id } } });
	expect(selected.ok()).toBe(true);
	await page.reload();
};

const startRace = async (page: Page) => {
	await page.getByRole("button", { name: "Race", exact: true }).click();
	const window = page.getByRole("dialog", { name: "Race", exact: true });
	await window.getByRole("button", { name: "Fill field" }).click();
	await window.getByRole("button", { name: "Start race" }).click();
	await expect(window.getByRole("button", { name: "New race" })).toBeVisible();
	return window;
};

const sendStretch = async (page: Page) => {
	await page.getByRole("textbox", { name: "Message draft" }).fill("Start the race.");
	await page.getByRole("button", { name: "Generate Variant" }).click();
	const preview = page.getByRole("complementary", { name: "Prompt Plan preview" });
	await preview.getByText(/^Race ·/).click();
	await expect(preview.getByRole("textbox", { name: /^box:race block/ })).toContainText("Stretch 1:");
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(story(page).getByText("Off they go.")).toBeVisible();
};

test("inserting the Race adds its block to a preset that has none", async ({ page, request, llm }) => {
	await llm.chat({ chunks: ["Off they go."] });
	await attachPreset(page, request, []);
	await insertBox(page, "Race");
	await startRace(page);
	await sendStretch(page);
});

test("a disabled Race block stays off until the writer enables it from the notice", async ({ page, request, llm }) => {
	await llm.chat({ chunks: ["Off they go."] });
	await attachPreset(page, request, [{ reference: "box:race", enabled: false, role: "system" }]);
	await insertBox(page, "Race");
	await page.getByRole("button", { name: "Boxes", exact: true }).click();
	await expect(page.getByRole("list", { name: "Boxes" }).getByRole("listitem").filter({ hasText: "Race" })).toContainText("Race block is off in Lean.");
	await page.keyboard.press("Escape");
	const window = await startRace(page);
	await expect(window).toContainText("Race block is off in Lean.");
	await window.getByRole("button", { name: "Enable", exact: true }).click();
	await expect(window).not.toContainText("Race block is off");
	await sendStretch(page);
});
