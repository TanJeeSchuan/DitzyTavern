import type { APIRequestContext, Page, Route } from "@playwright/test";
import { test, expect, story } from "./fixtures";

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

test("a New Swipe shows the reply in progress on its Message before the server accepts it", async ({ page, llm }) => {
	await llm.chat({ chunks: ["First take."] }, { chunks: ["Second take."] });
	await page.goto("/");
	await sendDirect(page, "Again.");
	const reply = story(page).locator("article[data-message-id]").last();
	await expect(reply.getByText("First take.")).toBeVisible();
	await expect(page.getByRole("button", { name: "Generate Variant" })).toBeVisible();
	const accepting = holdPost(page, "**/sibling/generations");
	await reply.getByRole("button", { name: "New Swipe" }).click();
	const route = await accepting;
	await expect(reply.getByRole("status", { name: /is writing/ })).toBeVisible();
	await expect(reply.getByText("1 of 1")).toBeVisible();
	await route.continue();
	await expect(reply.getByText("Second take.")).toBeVisible();
	await expect(reply.getByText("2 of 2")).toBeVisible();
});
