import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, story } from "./fixtures";

// Sixty Messages: the story opens on the latest fifty with one older page to load.
const openTwoPages = async (page: Page, request: APIRequestContext) => {
	const { activeChatId } = await (await request.get("/api/workspace")).json();
	const initial = await (await request.get(`/api/conversations/${activeChatId}/history`)).json();
	let conversation = await (await request.get(`/api/conversations/${activeChatId}`)).json();
	for (let position = initial.page.totalMessages + 1; position <= 60; position++) {
		const timestamp = new Date(Date.UTC(2026, 0, 1, 0, position)).toISOString();
		const action = { type: "create-message", timestamp, authorParticipantId: conversation.control.humanParticipantId, variantContents: [`History passage ${position}.`] };
		const response = await request.post(`/api/conversations/${activeChatId}/commands`, { data: { expectedRevision: conversation.revision, action } });
		expect(response.ok()).toBe(true);
		({ conversation } = await response.json());
	}
	await page.goto("/");
	const articles = story(page).locator("article[data-message-id]");
	await expect(articles).toHaveCount(50);
	return { articles, scroll: story(page).locator(".story-scroll") };
};

// Clicked in place: a pointer click would first scroll the button, and the reader, back to the top.
const loadMore = (page: Page, smoothTo?: number) => page.getByRole("button", { name: "Load more Messages" })
	.evaluate((button: HTMLElement, smoothTo) => {
		button.click();
		if (smoothTo !== undefined) button.closest(".story-scroll")?.scrollTo({ top: smoothTo, behavior: "smooth" });
	}, smoothTo);

for (const readingFrom of [0, 300]) test(`loading older Messages ${readingFrom} px from the top keeps the Message being read in place after content below changed size`, async ({ page, request }) => {
	const { articles, scroll } = await openTwoPages(page, request);
	await scroll.evaluate((element, top) => element.scrollTo({ top, behavior: "instant" }), readingFrom);
	const reading = story(page).locator(`article[data-message-id="${await articles.first().getAttribute("data-message-id")}"]`);
	const top = () => reading.evaluate((element) => Math.round(element.getBoundingClientRect().top));
	const before = await top();
	// A late font, image or Box mark settles a Message below the one being read to a different height.
	await articles.last().evaluate((element) => { element.style.paddingBottom = "120px"; });

	await loadMore(page);
	await expect(articles).toHaveCount(60);
	await expect.poll(async () => Math.abs(await top() - before)).toBeLessThanOrEqual(2);
});

test("older Messages landing during a smooth scroll do not let it carry on to its old target", async ({ page, request }) => {
	await page.emulateMedia({ reducedMotion: "no-preference" });
	const { articles, scroll } = await openTwoPages(page, request);
	await scroll.evaluate((element) => element.scrollTo({ top: 0, behavior: "instant" }));
	await page.route("**/history?*", async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 150));
		await route.fallback();
	});
	await loadMore(page, 1500);
	await expect(articles).toHaveCount(60);
	await page.waitForTimeout(1500);
	// Left alone, the animation ends at 1500 px in content that has since grown above it, a page away from where the reader was.
	expect(await scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(1500);
});
