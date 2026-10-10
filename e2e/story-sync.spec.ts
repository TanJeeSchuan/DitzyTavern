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

const focus = (page: Page, visibilityState: "hidden" | "visible") => page.evaluate((value) => {
	Object.defineProperty(document, "visibilityState", { configurable: true, value });
	window.dispatchEvent(new Event("visibilitychange"));
}, visibilityState);

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
	const olderId = (await (await request.get(`${url}/history?page=2`)).json()).messages[0].id;
	await page.goto("/");
	await story(page).getByRole("button", { name: "Load more Messages", exact: true }).click();
	const messages = story(page).locator("article[data-message-id]");
	await expect(messages).toHaveCount(75);
	const oldestId = await messages.first().getAttribute("data-message-id");
	await focus(page, "hidden");
	const other = await context.newPage();
	await other.goto("/");
	await edit(other, editedId, "Edited in the other tab.");
	await expect(story(other).getByText("Edited in the other tab.", { exact: true })).toBeVisible();
	await story(other).getByRole("button", { name: "Load more Messages", exact: true }).click();
	await edit(other, olderId, "Older page edited in the other tab.");
	await expect(story(other).getByText("Older page edited in the other tab.", { exact: true })).toBeVisible();
	await expect(story(page).getByText("Older page edited in the other tab.", { exact: true })).toHaveCount(0);
	await expect(story(page).getByText("Edited in the other tab.", { exact: true })).toHaveCount(0);
	const conflict = page.waitForResponse((response) => response.url().endsWith(`${url}/commands`) && response.status() === 409);
	await edit(page, conflictId, "This stale edit must not apply.");
	await conflict;
	await expect(story(page).getByText("Edited in the other tab.", { exact: true })).toBeVisible();
	await expect(story(page).getByText("Older page edited in the other tab.", { exact: true })).toBeVisible();
	await expect(messages).toHaveCount(75);
	await expect(messages.first()).toHaveAttribute("data-message-id", oldestId!);
	const stale = story(page).locator(`[data-message-id="${conflictId}"]`);
	await expect(stale.getByRole("textbox", { name: "Edit Message" })).toHaveText("This stale edit must not apply.");
	await stale.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(story(page).getByText("This stale edit must not apply.", { exact: true })).toHaveCount(0);

	await edit(other, editedId, "Focus recovered this change.");
	await expect(story(other).getByText("Focus recovered this change.", { exact: true })).toBeVisible();
	await expect(story(page).getByText("Focus recovered this change.", { exact: true })).toHaveCount(0);
	await focus(page, "visible");
	await expect(story(page).getByText("Focus recovered this change.", { exact: true })).toBeVisible();
	await expect(messages).toHaveCount(75);
	await expect(messages.first()).toHaveAttribute("data-message-id", oldestId!);

	const draft = story(page).locator(`[data-message-id="${editedId}"]`);
	await draft.hover();
	await draft.getByRole("button", { name: "Edit", exact: true }).click();
	await draft.getByRole("textbox", { name: "Edit Message" }).fill("Draft written in this tab.");
	await focus(page, "hidden");
	await edit(other, editedId, "Changed while this tab was editing.");
	const refreshed = page.waitForResponse((response) => response.url().includes(`${url}/history`));
	await focus(page, "visible");
	await refreshed;
	await expect(story(page).getByText("Changed while this tab was editing.", { exact: true })).toHaveCount(0);
	await draft.getByRole("button", { name: "Save", exact: true }).click();
	await expect(draft.getByRole("alert")).toHaveText("Changed elsewhere. Save again to overwrite.");
	const stored = async () => {
		const { messages } = await (await request.get(`${url}/history`)).json();
		return messages.find((message: { id: number }) => message.id === editedId).variants.find((variant: { selected: boolean }) => variant.selected).content;
	};
	expect(await stored()).toBe("Changed while this tab was editing.");
	await draft.getByRole("button", { name: "Save", exact: true }).click();
	await expect(story(page).getByText("Draft written in this tab.", { exact: true })).toBeVisible();
	expect(await stored()).toBe("Draft written in this tab.");
	await other.close();
});
