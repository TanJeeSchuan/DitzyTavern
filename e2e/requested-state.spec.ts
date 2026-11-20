import { withDeadline } from "../src/shared/test-fixtures/deadline";
import type { APIRequestContext, Page, Route } from "@playwright/test";
import { test, expect, insertBox, story } from "./fixtures";
import type { E2eServer } from "./harness";

test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => window.localStorage.setItem("ditzytavern.inspect-prompt-plan-before-generating", "false"));
});

// Holds the next POST to `pattern` so the test can read the story while the server has not answered it.
const holdPost = async (page: Page, pattern: string) => {
	const held = Promise.withResolvers<Route>();
	await page.route(pattern, (route) => route.request().method() === "POST" ? held.resolve(route) : route.fallback(), { times: 1 });
	return held.promise;
};

const sendDirect = async (page: Page, text: string) => {
	const composer = page.getByRole("textbox", { name: "Message draft" });
	await expect(composer).toHaveAttribute("contenteditable", "true");
	await composer.fill(text);
	await page.getByRole("button", { name: "Generate Variant" }).click();
	return composer;
};

const appendModelMessage = async (request: APIRequestContext, variantContents: string[]) => {
	const { activeChatId } = await (await request.get("/api/workspace")).json();
	const conversation = await (await request.get(`/api/conversations/${activeChatId}`)).json();
	const response = await request.post(`/api/conversations/${activeChatId}/commands`, { data: {
		expectedRevision: conversation.revision,
		action: { type: "create-message", timestamp: new Date().toISOString(), authorParticipantId: conversation.control.modelParticipantId, variantContents },
	} });
	expect(response.ok()).toBe(true);
};

const swipePastLast = async (page: Page, llm: E2eServer) => {
	await llm.chat({ chunks: ["First take."] }, { chunks: ["Second take."] });
	await page.goto("/");
	await sendDirect(page, "Again.");
	const reply = story(page).locator("article[data-message-id]").last();
	await expect(reply.getByText("First take.")).toBeVisible();
	await expect(page.getByRole("button", { name: "Generate Variant" })).toBeVisible();
	const accepting = holdPost(page, "**/api/conversations/*/generations");
	await reply.getByRole("button", { name: "New Swipe" }).click();
	const route = await accepting;
	await expect(reply.getByText("2 of 2")).toBeVisible();
	await expect(reply.getByText("First take.")).toHaveCount(0);
	await expect(reply.getByRole("status", { name: /is writing/ })).toBeVisible();
	return { reply, route };
};

test("a Send shows the Message and its reply in progress before the server accepts it", async ({ page, llm }) => {
	await llm.chat({ chunks: ["The lamp flickers twice."] });
	await page.goto("/");
	const accepting = holdPost(page, "**/api/conversations/*/generations");
	const composer = await sendDirect(page, "I climb the stairs.");
	const route = await accepting;
	await expect(story(page).locator("article").getByText("I climb the stairs.")).toBeVisible();
	await expect(story(page).getByRole("status", { name: /is writing/ })).toBeVisible();
	await expect(composer).toHaveText("");
	await expect(page.getByRole("button", { name: "Stop Generation" })).toBeDisabled();
	await route.continue();
	await expect(story(page).getByText("The lamp flickers twice.")).toBeVisible();
	await expect(story(page).locator("article").getByText("I climb the stairs.")).toHaveCount(1);
});

test.describe(() => {
	test.use({ allowedBrowserErrors: /ERR_FAILED/ });

	test("a Send the server never accepts disappears and returns its text to the composer", async ({ page }) => {
		await page.goto("/");
		const accepting = holdPost(page, "**/api/conversations/*/generations");
		const composer = await sendDirect(page, "I climb the stairs.");
		const route = await accepting;
		await expect(story(page).locator("article").getByText("I climb the stairs.")).toBeVisible();
		await route.abort();
		await expect(page.getByText("Generation could not be started.", { exact: true })).toBeVisible();
		await expect(story(page).locator("article").getByText("I climb the stairs.")).toHaveCount(0);
		await expect(story(page).getByRole("status", { name: /is writing/ })).toHaveCount(0);
		await expect(composer).toHaveText("I climb the stairs.");
	});

	test("a Send shows its staged Moves and lensed prose before acceptance, and a refused one returns both to the composer", async ({ page }) => {
		await page.goto("/");
		await insertBox(page, "Phone");
		await page.getByRole("button", { name: "Phone", exact: true }).click();
		const phone = page.getByRole("dialog", { name: "Phone" });
		await phone.getByRole("textbox", { name: "Text Theodora Kline" }).fill("u up?");
		await phone.getByRole("button", { name: "Stage text" }).click();
		await phone.getByRole("button", { name: "Minimize Phone" }).click();
		const staged = page.locator("form.composer").getByRole("list", { name: "Phone Moves" });
		await expect(staged.getByRole("listitem")).toHaveText(["To Theodora Kline: u up?"]);
		const accepting = holdPost(page, "**/api/conversations/*/generations");
		const composer = await sendDirect(page, 'I wait.\n<sms from="Night Desk" to="Theodora Kline">still here</sms>');
		const route = await accepting;
		const requested = story(page).locator("article[data-requested]").first();
		await expect(requested.getByRole("list", { name: "Phone Moves" }).getByRole("listitem")).toHaveText(["To Theodora Kline: u up?"]);
		await expect(requested.getByRole("button", { name: "Night Desk texted Theodora Kline" })).toBeVisible();
		await expect(requested).not.toContainText("still here");
		await expect(staged).toHaveCount(0);
		await route.abort();
		await expect(story(page).locator("article[data-requested]")).toHaveCount(0);
		await expect(staged.getByRole("listitem")).toHaveText(["To Theodora Kline: u up?"]);
		await expect(composer).toContainText("I wait.");
	});

	test("a swipe the server never accepts returns to the Variant it was swiped from", async ({ page, llm }) => {
		const { reply, route } = await swipePastLast(page, llm);
		await route.abort();
		await expect(page.getByText("Generation could not be started.", { exact: true })).toBeVisible();
		await expect(reply.getByText("First take.")).toBeVisible();
		await expect(reply.getByText("1 of 1")).toBeVisible();
	});
});

test("accepted writes disable transcript controls until displayed history catches up", async ({ page, llm, request }) => {
	await llm.chat({ chunks: ["Theodora reads them."] });
	await page.goto("/");
	await insertBox(page, "Phone");
	await page.getByRole("button", { name: "Phone", exact: true }).click();
	const phone = page.getByRole("dialog", { name: "Phone" });
	for (const body of ["A", "B", "C"]) {
		await phone.getByRole("textbox", { name: "Text Theodora Kline" }).fill(body);
		await phone.getByRole("button", { name: "Stage text" }).click();
	}
	await phone.getByRole("button", { name: "Minimize Phone" }).click();
	await page.getByRole("button", { name: "Generate Variant" }).click();
	await expect(story(page).getByText("Theodora reads them.")).toBeVisible();
	const moves = story(page).locator("article[data-message-id]").nth(-2).getByRole("list", { name: "Phone Moves" });
	await expect(moves.getByRole("listitem")).toHaveText(["To Theodora Kline: A", "To Theodora Kline: B", "To Theodora Kline: C"]);
	const { activeChatId } = await (await request.get("/api/workspace")).json();
	const url = `/api/conversations/${activeChatId}`;
	await expect.poll(async () => (await (await request.get(url)).json()).activeGenerations.length).toBe(0);
	const conversation = await (await request.get(url)).json();
	const history = await (await request.get(`${url}/history`)).json();
	const last = history.messages.at(-1);
	const extra = await request.post(`${url}/commands`, { data: {
		expectedRevision: conversation.revision,
		action: { type: "create-variant", messageId: last.id, sourceVariantId: last.variants[0].id, content: "Another take." },
	} });
	expect(extra.ok()).toBe(true);
	await page.reload();
	const reply = story(page).locator("article[data-message-id]").last();
	await reply.hover();
	await reply.getByRole("button", { name: "Edit", exact: true }).click();
	await reply.getByRole("textbox", { name: "Edit Message" }).fill("Draft kept while history loads.");
	const held = Promise.withResolvers<void>();
	await page.route(`**${url}/history*`, async (route) => { await withDeadline(held.promise, "release of the held history route"); await route.continue(); });
	const releaseCommand = Promise.withResolvers<void>();
	const guard = page.getByRole("dialog", { name: "Unsaved changes" });
	try {
		await page.route(`**${url}/commands`, async (route) => {
			await withDeadline(releaseCommand.promise, "release of the held Moves command");
			await route.continue();
		}, { times: 1 });
		await Promise.all([
			page.waitForRequest((request) => request.url().endsWith(`${url}/commands`) && request.method() === "POST", { timeout: 5_000 }),
			moves.getByRole("button", { name: "Remove To Theodora Kline: A" }).click(),
		]);
		await expect(moves.getByRole("button", { name: "Remove To Theodora Kline: B" })).toBeDisabled();
		const editedMoves = story(page).locator("article[data-message-id]").nth(-2);
		await editedMoves.hover();
		await expect(editedMoves.getByRole("button", { name: "Edit", exact: true })).toBeDisabled();
		await expect(editedMoves.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
		await reply.hover();
		await reply.getByRole("button", { name: /browse Swipes/ }).click();
		const browser = page.getByRole("dialog", { name: "Swipes", exact: true });
		await expect(browser).toBeVisible();
		const refreshed = Promise.all([
			page.waitForResponse((response) => response.url().endsWith(`${url}/commands`) && response.ok(), { timeout: 5_000 }),
			page.waitForRequest((sent) => new URL(sent.url()).pathname === `${url}/history`, { timeout: 5_000 }),
		]);
		releaseCommand.resolve();
		await refreshed;
		await expect(browser.getByRole("button", { name: "Swipe 1 of 2", exact: true })).toBeDisabled();
		await expect(browser.getByRole("button", { name: "Swipe 2 of 2", exact: true })).toBeDisabled();
		await browser.press("Escape");
		await expect(moves.getByRole("button", { name: "Remove To Theodora Kline: B" })).toBeDisabled();
		await expect(reply.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
		await reply.hover();
		await expect(reply.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
		await expect(reply.getByRole("button", { name: "Previous Swipe", exact: true })).toBeDisabled();
		await expect(reply.getByRole("textbox", { name: "Edit Message" })).toHaveText("Draft kept while history loads.");
		await page.getByRole("button", { name: "Chats", exact: true }).click();
		await page.getByRole("button", { name: /^The Lantern House/ }).click();
		await expect(guard.getByRole("button", { name: "Save and leave" })).toBeDisabled();
	} finally {
		releaseCommand.resolve();
		held.resolve();
	}
	await expect(guard.getByRole("button", { name: "Save and leave" })).toBeEnabled();
	await guard.getByRole("button", { name: "Keep editing" }).click();
	await expect(moves.getByRole("button", { name: "Remove To Theodora Kline: B" })).toBeEnabled();
	await expect(reply.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
	await expect(reply.getByRole("button", { name: "Delete", exact: true })).toBeEnabled();
	await expect(reply.getByRole("button", { name: "Previous Swipe", exact: true })).toBeEnabled();
	await reply.getByRole("button", { name: "Cancel", exact: true }).click();
	await guard.getByRole("button", { name: "Discard", exact: true }).click();
	const secondApplied = page.waitForResponse((response) => response.url().endsWith(`${url}/commands`) && response.ok());
	await moves.getByRole("button", { name: "Remove To Theodora Kline: B" }).click();
	await secondApplied;
	await expect(moves.getByRole("button", { name: "Remove To Theodora Kline: C" })).toBeEnabled();
	await page.reload();
	await expect(story(page).locator("article[data-message-id]").nth(-2).getByRole("list", { name: "Phone Moves" }).getByRole("listitem"))
		.toHaveText(["To Theodora Kline: C"]);
});

test("a Swipe on the final Message shows its Variant before the server applies it", async ({ page, request }) => {
	await appendModelMessage(request, ["First take.", "Second take."]);
	await page.goto("/");
	const reply = story(page).locator("article[data-message-id]").last();
	await expect(reply.getByText("1 of 2")).toBeVisible();
	const applying = holdPost(page, "**/api/conversations/*/commands");
	await reply.getByRole("button", { name: "Next Swipe" }).click();
	const route = await applying;
	await expect(reply.getByText("Second take.")).toBeVisible();
	await expect(reply.getByText("2 of 2")).toBeVisible();
	await route.continue();
	await page.waitForResponse((response) => response.url().endsWith("/commands") && response.ok());
	await page.reload();
	await expect(story(page).locator("article[data-message-id]").last().getByText("Second take.")).toBeVisible();
});

test("reloading the Chat discards an unconfirmed Swipe Preview", async ({ page, request }) => {
	await appendModelMessage(request, ["First take.", "Second take."]);
	await appendModelMessage(request, ["Later Message."]);
	await page.goto("/");
	const older = story(page).locator("article[data-message-id]").nth(-2);
	const preview = story(page).getByRole("status", { name: "Swipe preview" });
	await expect(older.getByText("First take.")).toBeVisible();
	await older.hover();
	await older.getByRole("button", { name: "Next Swipe" }).click();
	await expect(preview).toBeVisible();
	await expect(older.getByText("Second take.")).toBeVisible();

	await page.reload();
	await expect(older.getByText("First take.")).toBeVisible();
	await expect(preview).toHaveCount(0);
});

test("swiping past the last Variant shows the new Variant in progress before the server accepts it", async ({ page, llm }) => {
	const { reply, route } = await swipePastLast(page, llm);
	await route.continue();
	await expect(reply.getByText("Second take.")).toBeVisible();
	await expect(reply.getByText("2 of 2")).toBeVisible();
});
