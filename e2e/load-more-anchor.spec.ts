import { test, expect, story } from "./fixtures";

test("loading older Messages keeps the Message being read in place after content below changed size", async ({ page, request }) => {
	const { activeChatId } = await (await request.get("/api/workspace")).json();
	const initial = await (await request.get(`/api/conversations/${activeChatId}/history`)).json();
	let conversation = await (await request.get(`/api/conversations/${activeChatId}`)).json();
	for (let position = initial.page.totalMessages + 1; position <= 60; position++) {
		const response = await request.post(`/api/conversations/${activeChatId}/commands`, { data: {
			expectedRevision: conversation.revision,
			action: { type: "create-message", timestamp: new Date(Date.UTC(2026, 0, 1, 0, position)).toISOString(), authorParticipantId: conversation.control.humanParticipantId, variantContents: [`History passage ${position}.`] },
		} });
		expect(response.ok()).toBe(true);
		({ conversation } = await response.json());
	}
	await page.goto("/");
	const articles = story(page).locator("article[data-message-id]");
	await expect(articles).toHaveCount(50);
	const scroll = story(page).locator(".story-scroll");
	await scroll.evaluate((element) => element.scrollTo({ top: 0, behavior: "instant" }));
	const reading = story(page).locator(`article[data-message-id="${await articles.first().getAttribute("data-message-id")}"]`);
	const top = () => reading.evaluate((element) => Math.round(element.getBoundingClientRect().top));
	const before = await top();
	// A late font, image or Box mark settles a Message below the one being read to a different height.
	await articles.last().evaluate((element) => { element.style.paddingBottom = "120px"; });

	await page.getByRole("button", { name: "Load more Messages" }).click();
	await expect(articles).toHaveCount(60);
	await expect.poll(top).toBeGreaterThanOrEqual(before - 2);
	expect(await top()).toBeLessThanOrEqual(before + 2);
});
