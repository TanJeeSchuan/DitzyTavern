import type { Locator, Page } from "@playwright/test";
import { test, expect, send, story } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const drag = async (page: Page, on: Locator, fromX: number, toX: number, dy = 0) => {
	await on.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
	const box = await on.boundingBox();
	if (box === null) throw new Error("drag target is not visible");
	const y = box.y + box.height / 2;
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: fromX, y }] });
	for (let step = 1; step <= 5; step++) {
		await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: fromX + (toX - fromX) * step / 5, y: y + dy * step / 5 }] });
	}
	await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};

test("swiping a reply sideways generates and switches Swipes, scrolling does not", async ({ page, llm }) => {
	const firstTake = Array.from({ length: 30 }, (_, line) => `First take, line ${line}.`).join("\n\n");
	await llm.chat({ chunks: [firstTake] }, { chunks: ["Second take."] });
	await page.goto("/");
	await send(page, "Again.");
	const reply = story(page).locator("article").last();
	const lastLine = reply.getByText("First take, line 29.");
	await expect(lastLine).toBeVisible();

	const scroller = story(page).locator(".story-scroll");
	const scrollTop = () => scroller.evaluate((element) => element.scrollTop);
	const before = await scrollTop();
	const sendPlan = page.getByRole("button", { name: "Send exact plan" });
	await drag(page, lastLine, 320, 240, 160);
	await expect.poll(scrollTop).toBeLessThan(before);
	await expect(sendPlan.waitFor({ timeout: 1000 })).rejects.toThrow();

	await drag(page, reply.getByText("First take, line 25."), 320, 180);
	await sendPlan.click();
	await expect(reply.getByText("Second take.")).toBeVisible();
	await expect(reply.getByText("2 of 2")).toBeVisible();

	await drag(page, reply.getByText("Second take."), 80, 220);
	await expect(lastLine).toBeVisible();
	await expect(reply.getByText("1 of 2")).toBeVisible();
});
