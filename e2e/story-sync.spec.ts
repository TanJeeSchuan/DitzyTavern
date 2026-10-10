import type { Page } from "@playwright/test";
import { test, expect, story } from "./fixtures";

test.use({ allowedBrowserErrors: /status of 409/ });

const edit = async (page: Page, messageId: number, text: string) => {
	const message = story(page).locator(`[data-message-id="${messageId}"]`);
	await message.hover();
	await message.getByRole("button", { name: "Edit", exact: true }).click();
	await message.getByRole("textbox", { name: "Edit Message" }).fill(text);
	await message.getByRole("button", { name: "Save", exact: true }).click();
};

test("conflict and focus refresh every loaded history page across two tabs", async ({ page, context, request }) => {
	const { activeChatId } = await (await request.get("/api/workspace")).json();
	const url = `/api/conversations/${activeChatId}`;
	let conversation = await (await request.get(url)).json();
	const initial = await (await request.get(`${url}/history`)).json();
	for (let position = initial.page.totalMessages + 1; position <= 75; position++) {
		const response = await request.post(`${url}/commands`, { data: {
			expectedRevision: conversation.revision,
			action: { type: "create-message", timestamp: new Date(Date.UTC(2026, 0, 1, 0, position)).toISOString(),
				authorParticipantId: conversation.control.humanParticipantId, variantContents: [`Passage ${position}.`] },
		} });
		expect(response.ok()).toBe(true);
		({ conversation } = await response.json());
	}
	const history = await (await request.get(`${url}/history`)).json();
	const editedId = history.messages.at(-1).id;
	const conflictId = history.messages.at(-2).id;
	await page.goto("/");
	await story(page).getByRole("button", { name: "Load more Messages", exact: true }).click();
	const messages = story(page).locator("article[data-message-id]");
	await expect(messages).toHaveCount(75);
	const oldestId = await messages.first().getAttribute("data-message-id");
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
		window.dispatchEvent(new Event("visibilitychange"));
	});
	const other = await context.newPage();
	await other.goto("/");
	await edit(other, editedId, "Edited in the other tab.");
	await expect(story(other).getByText("Edited in the other tab.", { exact: true })).toBeVisible();
	await expect(story(page).getByText("Edited in the other tab.", { exact: true })).toHaveCount(0);
	const conflict = page.waitForResponse((response) => response.url().endsWith(`${url}/commands`) && response.status() === 409);
	await edit(page, conflictId, "This stale edit must not apply.");
	await conflict;
	await expect(story(page).getByText("Edited in the other tab.", { exact: true })).toBeVisible();
	await expect(messages).toHaveCount(75);
	await expect(messages.first()).toHaveAttribute("data-message-id", oldestId!);
	await expect(story(page).getByText("This stale edit must not apply.", { exact: true })).toHaveCount(0);

	await edit(other, editedId, "Focus recovered this change.");
	await expect(story(other).getByText("Focus recovered this change.", { exact: true })).toBeVisible();
	await expect(story(page).getByText("Focus recovered this change.", { exact: true })).toHaveCount(0);
	await page.evaluate(() => {
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		window.dispatchEvent(new Event("visibilitychange"));
	});
	await expect(story(page).getByText("Focus recovered this change.", { exact: true })).toBeVisible();
	await expect(messages).toHaveCount(75);
	await expect(messages.first()).toHaveAttribute("data-message-id", oldestId!);
	await other.close();
});
