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

test("Save and leave cannot retarget a draft after another tab selects a different Swipe", async ({ page, request }) => {
	const { activeChatId } = await (await request.get("/api/workspace")).json();
	const url = `/api/conversations/${activeChatId}`;
	let conversation = await (await request.get(url)).json();
	const created = await request.post(`${url}/commands`, { data: {
		expectedRevision: conversation.revision,
		action: { type: "create-message", timestamp: new Date().toISOString(), authorParticipantId: conversation.control.modelParticipantId, variantContents: ["Swipe A.", "Swipe B."] },
	} });
	expect(created.ok()).toBe(true);
	({ conversation } = await created.json());
	const history = await (await request.get(`${url}/history`)).json();
	const target = history.messages.at(-1);
	await page.goto("/");
	const message = story(page).locator(`[data-message-id="${target.id}"]`);
	await expect(message).toContainText("Swipe A.");
	await message.hover();
	await message.getByRole("button", { name: "Edit", exact: true }).click();
	const editor = message.getByRole("textbox", { name: "Edit Message" });
	await editor.fill("Draft for Swipe A.");
	const selected = await request.post(`${url}/commands`, { data: {
		expectedRevision: conversation.revision,
		action: { type: "select-variant", messageId: target.id, variantId: target.variants[1].id },
	} });
	expect(selected.ok()).toBe(true);
	await focus(page, "hidden");
	await focus(page, "visible");
	await expect(message).toContainText("2 of 2");
	await message.getByRole("button", { name: "Save", exact: true }).click();
	await expect(message.getByRole("alert")).toBeVisible();
	await page.getByRole("button", { name: "Chats", exact: true }).click();
	const guard = page.getByRole("dialog", { name: "Unsaved changes" });
	await guard.getByRole("button", { name: "Save and leave" }).click();
	await expect(guard.getByRole("alert")).toBeVisible();
	await guard.getByRole("button", { name: "Keep editing" }).click();
	await expect(editor).toHaveText("Draft for Swipe A.");
	const stored = await (await request.get(`${url}/history`)).json();
	expect(stored.messages.at(-1).variants[1]).toMatchObject({ selected: true, content: "Swipe B." });
});

test("Save and leave keeps a refused Save as new Swipe as a copy", async ({ page, request }) => {
	const { activeChatId } = await (await request.get("/api/workspace")).json();
	const url = `/api/conversations/${activeChatId}`;
	const conversation = await (await request.get(url)).json();
	const history = await (await request.get(`${url}/history`)).json();
	const original = history.messages.at(-1);
	const selected = original.variants.find((variant: { selected: boolean }) => variant.selected);
	await page.goto("/");
	const message = story(page).locator(`[data-message-id="${original.id}"]`);
	await message.hover();
	await message.getByRole("button", { name: "Edit", exact: true }).click();
	await message.getByRole("textbox", { name: "Edit Message" }).fill("My draft belongs in a copy.");
	const changed = await request.post(`${url}/commands`, { data: {
		expectedRevision: conversation.revision,
		action: { type: "edit-variant", messageId: original.id, variantId: selected.id, content: "Changed in another tab." },
	} });
	expect(changed.ok()).toBe(true);
	const { conversation: changedConversation } = await changed.json();
	const added = await request.post(`${url}/commands`, { data: {
		expectedRevision: changedConversation.revision,
		action: { type: "create-message", timestamp: new Date().toISOString(), authorParticipantId: conversation.control.humanParticipantId, variantContents: ["A new Message from the other tab."] },
	} });
	expect(added.ok()).toBe(true);
	await focus(page, "hidden");
	await focus(page, "visible");
	await expect(story(page).getByText("A new Message from the other tab.")).toBeVisible();
	await message.getByRole("button", { name: "Save as new Swipe" }).click();
	await expect(message.getByRole("alert")).toContainText("Changed elsewhere");
	await page.getByRole("button", { name: "Chats", exact: true }).click();
	const guard = page.getByRole("dialog", { name: "Unsaved changes" });
	await guard.getByRole("button", { name: "Save and leave" }).click();
	await expect(guard).toBeHidden();
	const stored = await (await request.get(`${url}/history`)).json();
	const saved = stored.messages.find((entry: { id: number }) => entry.id === original.id);
	const oldText = await (await request.get(`${url}/messages/${original.id}/variants/${selected.id}/text`)).json();
	expect(oldText.content).toBe("Changed in another tab.");
	expect(saved.variants.find((variant: { selected: boolean }) => variant.selected)).toMatchObject({ content: "My draft belongs in a copy." });
	expect(saved.variants).toHaveLength(original.variants.length + 1);
});

for (const changeSecondDraft of [false, true]) test(`Save and leave ${changeSecondDraft ? "keeps a concurrently changed Message unsaved" : "saves two Message drafts in sequence"}`, async ({ page, request }) => {
	const { activeChatId } = await (await request.get("/api/workspace")).json();
	const url = `/api/conversations/${activeChatId}`;
	let conversation = await (await request.get(url)).json();
	for (const position of [1, 2]) {
		const created = await request.post(`${url}/commands`, { data: {
			expectedRevision: conversation.revision,
			action: { type: "create-message", timestamp: new Date().toISOString(), authorParticipantId: conversation.control.humanParticipantId, variantContents: [`Original ${position}.`] },
		} });
		expect(created.ok()).toBe(true);
		({ conversation } = await created.json());
	}
	await page.goto("/");
	const drafts = story(page).locator("article[data-message-id]").filter({ hasText: /Original [12]\./ });
	await expect(drafts).toHaveCount(2);
	const ids = await drafts.evaluateAll((rows) => rows.map((row) => Number(row.getAttribute("data-message-id"))));
	for (const id of ids) {
		const message = story(page).locator(`[data-message-id="${id}"]`);
		await message.hover();
		await message.getByRole("button", { name: "Edit", exact: true }).click();
		await message.getByRole("textbox", { name: "Edit Message" }).fill(`Draft for ${id}.`);
	}
	const commands: { expectedRevision: number; action: { messageId: number } }[] = [];
	page.on("request", (sent) => {
		if (sent.url().endsWith(`${url}/commands`) && sent.method() === "POST") commands.push(sent.postDataJSON());
	});
	const held = Promise.withResolvers<void>();
	await page.route(`**${url}/history*`, async (route) => { await held.promise; await route.continue(); });
	await page.getByRole("button", { name: "Chats", exact: true }).click();
	const guard = page.getByRole("dialog", { name: "Unsaved changes" });
	const historyRequested = page.waitForRequest((sent) => new URL(sent.url()).pathname === `${url}/history`, { timeout: 5_000 });
	await guard.getByRole("button", { name: "Save and leave" }).click();
	await historyRequested;
	expect(commands).toHaveLength(1);
	const secondId = ids.find((id) => id !== commands[0]!.action.messageId)!;
	if (changeSecondDraft) {
		const { messages } = await (await request.get(`${url}/history`)).json();
		const target = messages.find((message: { id: number }) => message.id === secondId);
		const changed = await request.post(`${url}/commands`, { data: {
			expectedRevision: commands[0]!.expectedRevision + 1,
			action: { type: "edit-variant", messageId: secondId, variantId: target.variants[0].id, content: "Changed in another tab." },
		} });
		expect(changed.ok()).toBe(true);
	}
	held.resolve();
	if (changeSecondDraft) {
		await expect(guard.getByRole("alert")).toBeVisible();
		expect(commands).toHaveLength(1);
		await guard.getByRole("button", { name: "Keep editing" }).click();
		const second = story(page).locator(`[data-message-id="${secondId}"]`);
		await expect(second.getByRole("alert")).toContainText("Changed elsewhere");
		await expect(second.getByRole("textbox", { name: "Edit Message" })).toHaveText(`Draft for ${secondId}.`);
		return;
	}
	await expect(guard).toBeHidden();
	expect(commands).toEqual([
		expect.objectContaining({ expectedRevision: conversation.revision }),
		expect.objectContaining({ expectedRevision: conversation.revision + 1 }),
	]);
	const { messages } = await (await request.get(`${url}/history`)).json();
	for (const id of ids) expect(messages.find((message: { id: number }) => message.id === id).variants[0].content).toBe(`Draft for ${id}.`);
});

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
	const saved = other.waitForResponse((response) => response.url().endsWith(`${url}/commands`) && response.ok());
	await edit(other, editedId, "Changed while this tab was editing.");
	await saved;
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


test.describe(() => {
	test.use({ allowedBrowserErrors: /status of 500/ });
	test("Jump to latest after a history error protects an older Message draft", async ({ page, request }) => {
		const { activeChatId } = await (await request.get("/api/workspace")).json();
		const url = `/api/conversations/${activeChatId}`;
		let conversation = await (await request.get(url)).json();
		for (let i = 0; i < 50; i++) {
			const added = await request.post(`${url}/commands`, { data: {
				expectedRevision: conversation.revision,
				action: { type: "create-message", timestamp: new Date().toISOString(), authorParticipantId: conversation.control.humanParticipantId, variantContents: [`Passage ${i}.`] },
			} });
			expect(added.ok()).toBe(true);
			({ conversation } = await added.json());
		}
		await page.goto("/");
		const transcript = story(page);
		await transcript.getByRole("button", { name: "Load more Messages", exact: true }).click();
		const older = transcript.locator("article[data-message-id]").first();
		await expect.poll(() => transcript.locator("article[data-message-id]").count()).toBeGreaterThan(50);
		await older.hover();
		await older.getByRole("button", { name: "Edit", exact: true }).click();
		const draft = older.getByRole("textbox", { name: "Edit Message" });
		await draft.fill("Keep these edits.");
		await page.route(`**${url}/history*`, (route) => route.fulfill({ status: 500, json: { error: "Unavailable" } }));
		const renamed = await request.post(`${url}/commands`, { data: {
			expectedRevision: conversation.revision, action: { type: "rename-conversation", name: "Recovery test" },
		} });
		expect(renamed.ok()).toBe(true);
		await focus(page, "hidden");
		await focus(page, "visible");
		await expect(transcript.getByRole("alert").filter({ hasText: "The Chat history could not be loaded." })).toBeVisible();
		await page.unroute(`**${url}/history*`);
		const jump = transcript.getByRole("button", { name: "Jump to latest", exact: true });
		await jump.click();
		const guard = page.getByRole("dialog", { name: "Unsaved changes" });
		await guard.getByRole("button", { name: "Keep editing" }).click();
		await expect(draft).toHaveText("Keep these edits.");
		await jump.click();
		await guard.getByRole("button", { name: "Discard", exact: true }).click();
		await expect(transcript.locator("article[data-message-id]")).toHaveCount(50);
	});

	test("retrying the active Chat preserves the unsent composer draft and readable transcript", async ({ page, request }) => {
		const { activeChatId } = await (await request.get("/api/workspace")).json();
		const url = `/api/conversations/${activeChatId}`;
		await page.goto("/");
		const articles = story(page).locator("article[data-message-id]");
		await expect(articles.first()).toBeVisible();
		const count = await articles.count();
		const draft = page.getByRole("textbox", { name: "Message draft" });
		await draft.fill("Unsent guidance survives retry.");
		await page.route(`**${url}/history*`, (route) => route.fulfill({ status: 500, json: { error: "Unavailable" } }));
		const conversation = await (await request.get(url)).json();
		expect((await request.post(`${url}/commands`, { data: { expectedRevision: conversation.revision, action: { type: "rename-conversation", name: "Retry this Chat" } } })).ok()).toBe(true);
		await focus(page, "hidden");
		await focus(page, "visible");
		await expect(story(page).getByRole("alert").filter({ hasText: "The Chat history could not be loaded." })).toBeVisible();
		await expect(story(page).getByRole("button", { name: "Jump to latest", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Chats", exact: true }).click();
		const retried = page.waitForResponse((response) => response.url().includes(`${url}/history`) && response.status() === 500);
		await page.locator('button[aria-current="true"]').click();
		await retried;
		await expect(articles).toHaveCount(count);
		await expect(draft).toHaveText("Unsent guidance survives retry.");
		await page.unroute(`**${url}/history*`);
		await page.getByRole("button", { name: "Chats", exact: true }).click();
		await page.locator('button[aria-current="true"]').click();
		await expect(story(page).getByRole("alert")).toHaveCount(0);
		await expect(story(page).getByRole("button", { name: "Jump to latest", exact: true })).toBeHidden();
		await expect(draft).toHaveText("Unsent guidance survives retry.");
	});
});
