import type { Page } from "@playwright/test";
import { test, expect, send, story } from "./fixtures";
import type { E2eServer } from "./harness";

const threeTakes = async (page: Page, llm: E2eServer) => {
	await llm.chat({ chunks: ["First take."] }, { chunks: ["Second take."] }, { chunks: ["Third take."] });
	await page.goto("/");
	await send(page, "Again.");
	const reply = story(page).locator("article").last();
	await expect(reply.getByText("First take.")).toBeVisible();
	for (const take of ["Second take.", "Third take."]) {
		await reply.getByLabel("New Swipe").click();
		await page.getByRole("button", { name: "Send exact plan" }).click();
		await expect(reply.getByText(take)).toBeVisible();
	}
	await expect(reply.getByText("3 of 3")).toBeVisible();
	return reply;
};

test("the Swipe fan browses with arrow keys, dismisses without changes, and selects a Swipe", async ({ page, llm }) => {
	const reply = await threeTakes(page, llm);
	const fan = page.getByRole("dialog", { name: "Swipes" });

	await reply.getByRole("button", { name: "3 of 3, browse Swipes" }).click();
	await expect(fan.getByRole("button", { name: "Swipe 3 of 3" })).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await expect(fan.getByRole("button", { name: "Swipe 2 of 3" })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(fan).toBeHidden();
	await expect(reply.getByText("Third take.")).toBeVisible();
	await expect(reply.getByRole("button", { name: "3 of 3, browse Swipes" })).toBeFocused();

	await reply.getByRole("button", { name: "3 of 3, browse Swipes" }).click();
	await page.keyboard.press("ArrowLeft");
	await page.mouse.click(8, 8);
	await expect(fan).toBeHidden();
	await expect(reply.getByText("3 of 3")).toBeVisible();

	await reply.getByRole("button", { name: "3 of 3, browse Swipes" }).click();
	await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("Enter");
	await expect(fan).toBeHidden();
	await expect(reply.getByText("First take.")).toBeVisible();
	await expect(reply.getByText("1 of 3")).toBeVisible();
	await page.reload();
	const reloaded = story(page).locator("article").last();
	await expect(reloaded.getByText("1 of 3")).toBeVisible();

	// A screen reader activates a card with a bare click and no pointer events.
	await reloaded.getByRole("button", { name: "1 of 3, browse Swipes" }).click();
	await page.keyboard.press("ArrowRight");
	await fan.getByRole("button", { name: "Swipe 2 of 3" }).dispatchEvent("click");
	await expect(fan).toBeHidden();
	await expect(reloaded.getByText("2 of 3")).toBeVisible();
});

test("the Modal choice lists the Swipes, selects one, and stays chosen after a reload", async ({ page, llm }) => {
	const reply = await threeTakes(page, llm);
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("radiogroup", { name: "Swipes" }).getByRole("radio", { name: "Modal" }).click();

	await reply.getByRole("button", { name: "3 of 3, browse Swipes" }).click();
	const list = page.getByRole("dialog", { name: "Swipes" });
	await expect(list.getByRole("button", { name: /^Swipe \d of 3$/ })).toHaveCount(3);
	await expect(list.getByRole("button", { name: "Swipe 3 of 3" })).toBeFocused();
	await list.getByRole("button", { name: "Swipe 2 of 3" }).click();
	await expect(list).toBeHidden();
	await expect(reply.getByText("Second take.")).toBeVisible();
	await expect(reply.getByText("2 of 3")).toBeVisible();

	await page.reload();
	const reloaded = story(page).locator("article").last();
	await reloaded.getByRole("button", { name: "2 of 3, browse Swipes" }).click();
	await expect(page.getByRole("dialog", { name: "Swipes" }).getByRole("button", { name: "Close" })).toBeVisible();
});

test.describe("touch", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

	test("a long press opens the fan, a flick browses it and a tap selects, while a held scroll does not open it", async ({ page, llm }) => {
		const reply = await threeTakes(page, llm);
		const fan = page.getByRole("dialog", { name: "Swipes" });
		const cdp = await page.context().newCDPSession(page);
		const touch = (type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) =>
			cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
		const hold = async (dy: number) => {
			const box = await reply.getByText("Third take.").boundingBox();
			if (box === null) throw new Error("the reply is not visible");
			await touch("touchStart", box.x + 10, box.y + box.height / 2);
			if (dy !== 0) await touch("touchMove", box.x + 10, box.y + box.height / 2 + dy);
			await page.waitForTimeout(700);
			await touch("touchEnd");
		};

		await hold(40);
		await expect(fan).toBeHidden();

		await hold(0);
		await expect(fan.getByRole("button", { name: "Swipe 3 of 3" })).toBeFocused();

		await touch("touchStart", 120, 422);
		for (let step = 1; step <= 4; step++) await touch("touchMove", 120 + step * 50, 422);
		await touch("touchEnd");
		await expect(fan.getByRole("button", { name: "Swipe 1 of 3" })).toBeFocused();
		await expect(reply.getByText("3 of 3")).toBeVisible();

		await fan.getByRole("button", { name: "Swipe 1 of 3" }).tap();
		await expect(fan).toBeHidden();
		await expect(reply.getByText("First take.")).toBeVisible();
		await expect(reply.getByText("1 of 3")).toBeVisible();
	});
});
