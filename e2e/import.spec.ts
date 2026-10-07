import { readFileSync } from "node:fs";
import { test, expect, story } from "./fixtures";

const sentAt = (minute: number, second = 0) => new Date(Date.UTC(2026, 0, 1, 0, minute, second)).toISOString();

const exportFile = (integrity: string) => Buffer.from([
	{ chat_metadata: { integrity }, user_name: "TANJS", character_name: "Rulership" },
	{ name: "Writer", is_user: true, send_date: sentAt(0, 1), mes: "Guidance 1: the lantern house waits." },
	{
		name: "Rulership", is_user: false, send_date: "2026-08-08T13:04:55.256Z",
		mes: "Second alternative, still saved",
		swipes: ["First alternative text", "Second alternative, still saved", ""],
		swipe_id: 1,
		swipe_info: [{ send_date: "2026-08-08T13:04:50.000Z" }, { send_date: "2026-08-08T13:04:55.256Z" }, { send_date: "2026-08-08T13:05:00.000Z" }],
	},
	...Array.from({ length: 58 }, (_, offset) => offset + 3).map((index) => index % 2 === 0
		? { name: "Rulership", is_user: false, send_date: sentAt(index), mes: `Rulership answers ${index} with measured prose.` }
		: { name: "Writer", is_user: true, send_date: sentAt(0, index), mes: `Guidance ${index}: the lantern house waits.` }),
].map((record) => JSON.stringify(record)).join("\n"));

for (const layout of [{ name: "desktop", viewport: { width: 1440, height: 900 } }, { name: "narrow", viewport: { width: 420, height: 820 } }]) {
	test.describe(layout.name, () => {
		test.use({ viewport: layout.viewport });

		test("an imported SillyTavern chat opens with its swipes, history and preserved source", async ({ page }) => {
			const filename = `import-${layout.name}.jsonl`;
			const source = exportFile(`e2e-${layout.name}`);
			await page.goto("/");
			if (layout.name === "narrow") await page.getByRole("button", { name: "Open navigation" }).click();
			await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Chats", exact: true }).click();
			await page.getByRole("button", { name: "Import", exact: true }).click();
			await page.getByRole("complementary").locator('input[type="file"]').setInputFiles({ name: filename, mimeType: "application/jsonl", buffer: source });
			await expect(page.getByText("Resolve Participants", { exact: true })).toBeVisible();
			await page.getByPlaceholder("Title this Chat").fill("Lantern House Import");
			await page.getByRole("button", { name: "Continue to review", exact: true }).click();
			await page.getByRole("button", { name: "Import this Chat", exact: true }).click();
			await expect(page.getByText("Chat imported", { exact: true })).toBeVisible();
			await page.getByRole("button", { name: "Open Chat", exact: true }).click();

			await expect(story(page).getByRole("heading", { name: "Lantern House Import" })).toBeVisible();
			await expect(story(page).locator(".message-author strong").filter({ hasText: "Writer" }).first()).toBeVisible();
			await expect(story(page).locator(".message-author strong").filter({ hasText: "Rulership" }).first()).toBeVisible();

			await expect(story(page).getByText("Rulership answers 60")).toBeVisible();
			await story(page).getByRole("button", { name: "Load more Messages", exact: true }).click();
			const swiped = story(page).locator("article").filter({ hasText: "Second alternative, still saved" });
			const messageId = await swiped.getAttribute("data-message-id");
			const message = story(page).locator(`[data-message-id="${messageId}"]`);
			await message.hover();
			await expect(message.getByText("2 of 3", { exact: true })).toBeVisible();
			await message.getByRole("button", { name: "Next Swipe", exact: true }).click();
			await expect(message.getByText("3 of 3", { exact: true })).toBeVisible();
			await expect(message.getByText("(empty alternative)", { exact: true })).toBeVisible();
			await message.getByRole("button", { name: "Previous Swipe", exact: true }).click();
			await expect(message.getByText("2 of 3", { exact: true })).toBeVisible();


			if (layout.name === "narrow") {
				await story(page).getByRole("heading", { name: "Lantern House Import" }).getByRole("button").click();
				await page.getByRole("menuitem", { name: "Chat information" }).click();
			} else {
				await page.getByRole("button", { name: "Chat information", exact: true }).click();
			}
			await expect(page.getByRole("heading", { name: "Import Details", exact: true })).toBeVisible();
			const download = page.waitForEvent("download");
			await page.getByRole("button", { name: "Download original file", exact: true }).click();
			expect((await download).suggestedFilename()).toBe(filename);
			expect(readFileSync((await (await download).path())).equals(source)).toBe(true);
		});
	});
}
