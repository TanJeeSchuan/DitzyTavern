import { test, expect, insertBox, openBoxes as manager } from "./fixtures";

test.describe("a Box lifecycle change from a stale read", () => {
	// The deliberate 409 conflict response logs one browser console error.
	test.use({ allowedBrowserErrors: /status of 409/ });

	test("Remove never deletes setup another tab saved while the confirmation was open", async ({ page, request }) => {
		await page.goto("/");
		await insertBox(page, "World Clock");
		const boxes = await manager(page);
		await boxes.getByRole("button", { name: "World Clock actions" }).click();
		await page.getByRole("menuitem", { name: "Remove from Chat…" }).click();

		const { activeChatId } = await (await request.get("/api/workspace")).json();
		const { revision, boxSetups } = await (await request.get(`/api/conversations/${activeChatId}`)).json();
		const saved = await request.post(`/api/conversations/${activeChatId}/commands`, { data: {
			expectedRevision: revision, action: { type: "set-box-setup", box: "world-clock", setup: { ...boxSetups["world-clock"], era: "BE" } },
		} });
		expect(saved.ok()).toBe(true);

		await page.getByRole("dialog", { name: "Remove World Clock?" }).getByRole("button", { name: "Remove" }).click();
		await expect(page.getByRole("alert")).toHaveText("The Chat changed elsewhere; its Boxes were reloaded.");
		await expect(boxes.getByRole("switch", { name: "World Clock in this Chat" })).toBeChecked();
		const after = await (await request.get(`/api/conversations/${activeChatId}`)).json();
		expect(after.boxes["world-clock"]).toBe("enabled");
		expect(after.boxSetups["world-clock"].era).toBe("BE");
	});
});

test("a new Chat starts with only the Author Note and Memory enabled", async ({ page, request }) => {
	const emptyPrompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
	const created = await (await request.post("/api/conversations/native", { data: {
		name: "Fresh Chat",
		humanSeat: { type: "adhoc", definition: { name: "Writer", prompt: emptyPrompt, openings: [] } },
		modelSeat: { type: "adhoc", definition: { name: "Maren", prompt: emptyPrompt, openings: [] } },
	} })).json();
	expect(created.outcome).toBe("created");
	await page.goto("/");
	const boxes = await manager(page);
	for (const title of ["Author Note", "Memory"]) await expect(boxes.getByRole("switch", { name: `${title} in this Chat` })).toBeChecked();
	for (const title of ["World Clock", "Race", "Phone"]) {
		await expect(boxes.getByRole("switch", { name: `${title} in this Chat` })).toHaveCount(0);
		await expect(boxes.getByRole("button", { name: `Add ${title}`, exact: true })).toBeVisible();
	}
	await expect(boxes.getByRole("listitem").filter({ hasText: "World Clock" })).toContainText("Keeps the in-story time and weather that passages establish.");
});

test("on a narrow screen, closing the last Box window releases keyboard focus", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/");
	await insertBox(page, "Race");
	await page.getByRole("button", { name: "Race", exact: true }).click();
	await page.getByRole("button", { name: "Minimize Race" }).click();
	await page.getByRole("button", { name: /^Race: / }).click();
	await page.getByRole("dialog", { name: "Race", exact: true }).press("Escape");
	await expect(page.getByRole("dialog", { name: "Race", exact: true })).toBeHidden();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Tab");
	await expect(page.locator(".box-window-layer")).not.toBeFocused();
	expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
});

for (const width of [1440, 390]) test(`minimizing a Box preserves its unsaved setup at ${width}px`, async ({ page }) => {
	await page.setViewportSize({ width, height: 900 });
	await page.goto("/");
	await insertBox(page, "World Clock");
	await page.getByRole("button", { name: "World Clock", exact: true }).click();
	const window = page.getByRole("dialog", { name: "World Clock", exact: true });
	await window.getByRole("textbox", { name: "Era" }).fill("BE");
	await window.getByRole("button", { name: "Minimize World Clock" }).click();
	await expect(window).toBeHidden();
	await expect(page.getByRole("dialog", { name: "Unsaved changes" })).toHaveCount(0);
	const dock = page.getByRole("toolbar", { name: "Minimized Boxes" }).getByRole("button", { name: /^World Clock: / });
	await expect(dock).toBeVisible();
	await dock.focus();
	await expect(dock).toBeFocused();
	await dock.press("Enter");
	await expect(window.getByRole("textbox", { name: "Era" })).toHaveValue("BE");
	await expect(window).toBeFocused();
	await window.getByRole("button", { name: "Save World Clock" }).click();
	await expect(window.getByRole("button", { name: "Save World Clock" })).toBeDisabled();
	await window.getByRole("button", { name: "Close World Clock" }).click();
	await page.getByRole("button", { name: "World Clock", exact: true }).click();
	await expect(window.getByRole("textbox", { name: "Era" })).toHaveValue("BE");
});
