import { gifFixture } from "../src/server/image/image-fixtures";
import { test, expect, story } from "./fixtures";

// Chat information looks up Import Details, which a Chat made in DitzyTavern does not have.
test.use({ allowedBrowserErrors: /status of 404/ });

test("a Chat background is set from Chat information, keeps its GIF bytes, animates unless motion is reduced, and clears", async ({ page }) => {
	const gif = gifFixture();
	const { activeChatId } = await (await page.request.get("/api/workspace")).json();
	const background = async () => (await (await page.request.get(`/api/conversations/${activeChatId}`)).json()).background;
	await page.goto("/");
	await page.getByRole("button", { name: "Chat information" }).click();
	await page.getByLabel("Background file").setInputFiles({ name: "rain.gif", mimeType: "image/gif", buffer: gif });
	const layer = story(page).locator(".story-background");
	await expect(layer).toHaveJSProperty("width", 2);
	const hash = await background();
	expect(Buffer.compare(await (await page.request.get(`/api/images/${hash}`)).body(), gif)).toBe(0);

	await page.reload();
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await expect(layer).toHaveAttribute("src", `/api/images/${hash}`);

	await page.getByRole("button", { name: "Chat information" }).click();
	await page.getByRole("button", { name: "Remove" }).click();
	await expect(layer).toHaveCount(0);
	expect(await background()).toBeNull();
});
