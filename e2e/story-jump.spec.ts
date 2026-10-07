import { test, expect, send, story } from "./fixtures";

test("jumping to a source reads one window, pages newer, returns to latest and sends", async ({ page, request, llm }) => {
	const { activeChatId } = await (await request.get("/api/workspace")).json();
	const historyUrl = `/api/conversations/${activeChatId}/history`;
	const initial = await (await request.get(historyUrl)).json();
	let conversation = await (await request.get(`/api/conversations/${activeChatId}`)).json();
	for (let position = initial.page.totalMessages + 1; position <= 225; position++) {
		const response = await request.post(`/api/conversations/${activeChatId}/commands`, { data: {
			expectedRevision: conversation.revision,
			action: { type: "create-message", timestamp: new Date(Date.UTC(2026, 0, 1, 0, position)).toISOString(), authorParticipantId: conversation.control.humanParticipantId, variantContents: [`History passage ${position}.`] },
		} });
		expect(response.ok()).toBe(true);
		({ conversation } = await response.json());
	}
	const early = await (await request.get(`${historyUrl}?page=4`)).json();
	const target = early.messages.find((message: { position: number }) => message.position === 50);
	const requests: string[] = [];
	page.on("request", (request) => { if (new URL(request.url()).pathname === historyUrl) requests.push(request.url()); });
	await page.goto("/");
	const articles = story(page).locator("article[data-message-id]");
	await expect(articles).toHaveCount(50);
	await page.getByRole("button", { name: "Memories", exact: true }).click();
	const coverage = page.getByRole("slider", { name: "Messages by Memory state" });
	await coverage.focus();
	await coverage.press("Home");
	for (let step = 1; step < 50; step++) await coverage.press("ArrowRight");
	requests.length = 0;
	await coverage.press("Enter");
	const targetMessage = story(page).locator(`[data-message-id="${target.id}"]`);
	await expect(targetMessage).toBeInViewport();
	await expect(articles).toHaveCount(50);
	expect(requests).toHaveLength(1);
	expect(new URL(requests[0]!).searchParams.get("aroundMessageId")).toBe(String(target.id));
	await expect(story(page).getByText("History passage 225.", { exact: true })).toHaveCount(0);

	const scroll = story(page).locator(".story-scroll");
	await scroll.evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: "instant" }));
	await expect(articles).toHaveCount(100);
	await expect(story(page).getByText("History passage 125.", { exact: true })).toHaveCount(1);
	await story(page).getByRole("button", { name: "Jump to latest", exact: true }).click();
	await expect(articles).toHaveCount(50);
	await expect(story(page).getByText("History passage 225.", { exact: true })).toBeInViewport();
	await expect(story(page).getByRole("button", { name: "Jump to latest", exact: true })).toHaveCount(0);
	await llm.chat({ chunks: ["The story continues at the end.\n\n", "Then"], hold: true });
	await send(page, "Continue from the latest passage.");
	await expect(articles.last()).toContainText("The story continues at the end.");
	await expect(articles.last()).toBeInViewport();

	await page.getByRole("button", { name: "Memories", exact: true }).click();
	await coverage.focus();
	await coverage.press("Home");
	await coverage.press("Enter");
	await expect(story(page).getByRole("button", { name: "Jump to latest", exact: true })).toHaveCount(1);
	await expect(articles).toHaveCount(27);
	await llm.release();
	await expect(page.getByRole("button", { name: "Generate Variant" })).toBeVisible();
	await expect(articles).toHaveCount(27);
	await expect(story(page).getByText("The story continues at the end.", { exact: true })).toHaveCount(0);
	await llm.chat({ chunks: ["Sending reattached the story."] });
	await send(page, "Send while reading the beginning.");
	await expect(story(page).getByRole("button", { name: "Jump to latest", exact: true })).toHaveCount(0);
	await expect(articles.last()).toContainText("Sending reattached the story.");
	await expect(articles.last()).toBeInViewport();
});
