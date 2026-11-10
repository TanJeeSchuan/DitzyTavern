import { test, expect } from "./fixtures";

test.use({ viewport: { width: 412, height: 915 }, hasTouch: true });

for (const backwards of [false, true]) {
	test(`a ${backwards ? "backward" : "forward"} native selection inside an image chip cuts the Image Reference`, async ({ page }) => {
		await page.goto("/");
		const editor = page.getByRole("textbox", { name: "Message draft" });
		await expect(editor).toHaveAttribute("contenteditable", "true");
		await page.locator("form.composer input[type=file]").setInputFiles({
			name: "map.png",
			mimeType: "image/png",
			buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64"),
		});
		const chip = editor.locator(".image-chip");
		await expect(chip).toBeVisible();
		const hash = await chip.getAttribute("data-image-hash");
		await editor.fill(`before ![map](image:${hash}) after`);
		await chip.locator("span").evaluate((label, backwards) => {
			label.dispatchEvent(new Event("touchmove", { bubbles: true }));
			const length = label.textContent!.length;
			document.getSelection()!.setBaseAndExtent(label.firstChild!, backwards ? length : 0, label.firstChild!, backwards ? 0 : length);
			document.dispatchEvent(new Event("selectionchange"));
		}, backwards);
		await editor.evaluate((element) => element.dispatchEvent(new ClipboardEvent("cut", {
			bubbles: true,
			cancelable: true,
			clipboardData: new DataTransfer(),
		})));
		await expect(editor).toHaveText("before  after");
	});
}
