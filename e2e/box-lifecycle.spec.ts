import type { Page } from "@playwright/test";
import { test, expect, insertBox, story } from "./fixtures";

const manager = async (page: Page) => {
	await page.getByRole("button", { name: "Boxes", exact: true }).click();
	return page.getByRole("list", { name: "Boxes" });
};

const generate = async (page: Page, text: string) => {
	await page.getByRole("textbox", { name: "Message draft" }).fill(text);
	await page.getByRole("button", { name: "Generate Variant" }).click();
	return page.getByRole("complementary", { name: "Prompt Plan preview" });
};

const sendPlan = async (page: Page, reply: string) => {
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(story(page).getByText(reply, { exact: true })).toBeVisible();
};

test("a disabled Phone has no prompt item and keeps its dock tab and window, with its sent texts and its Moves unavailable, and comes back as it was", async ({ page, llm }) => {
	await llm.chat({ chunks: ["One."] }, { chunks: ["Two."] }, { chunks: ["Three."] });
	await page.goto("/");
	await insertBox(page, "Phone");
	await page.getByRole("button", { name: "Phone", exact: true }).click();
	const window = page.getByRole("dialog", { name: "Phone" });
	await window.getByRole("textbox", { name: /^Text / }).fill("Meet me at the pier.");
	await window.getByRole("button", { name: "Stage text" }).click();
	await window.getByRole("button", { name: "Minimize Phone" }).click();
	const dock = page.getByRole("button", { name: /^Phone: / });
	await expect(dock).toBeVisible();
	await expect((await generate(page, "Check the phone.")).getByText(/^Phone ·/)).toHaveCount(1);
	await sendPlan(page, "One.");

	const boxes = await manager(page);
	await boxes.getByRole("switch", { name: "Phone in this Chat" }).click();
	await expect(boxes.getByRole("listitem").filter({ hasText: "Phone" })).toContainText("Off · setup kept");
	await page.keyboard.press("Escape");
	await expect((await generate(page, "Leave it.")).getByText(/^Phone ·/)).toHaveCount(0);
	await sendPlan(page, "Two.");
	await dock.click();
	await expect(window).toContainText("Phone is off in this Chat.");
	await expect(window.getByText("Meet me at the pier.")).toBeVisible();
	await expect(window.getByRole("textbox", { name: /^Text / })).toBeDisabled();
	await window.getByRole("button", { name: "Minimize Phone" }).click();

	await insertBox(page, "Phone");
	await expect(dock).toBeVisible();
	await expect((await generate(page, "Pick it up.")).getByText(/^Phone ·/)).toHaveCount(1);
	await sendPlan(page, "Three.");
});

test("a disabled World Clock keeps its window and unsaved setup, which stays editable, and removing resets it", async ({ page }) => {
	await page.goto("/");
	await insertBox(page, "World Clock");
	await page.getByRole("button", { name: "World Clock", exact: true }).click();
	const window = page.getByRole("dialog", { name: "World Clock" });
	await window.getByRole("textbox", { name: "Era" }).fill("BE");

	let boxes = await manager(page);
	await boxes.getByRole("switch", { name: "World Clock in this Chat" }).click();
	await expect(boxes.getByRole("listitem").filter({ hasText: "World Clock" })).toContainText("Off · setup kept");
	await page.keyboard.press("Escape");
	await expect(window).toContainText("World Clock is off in this Chat.");
	await expect(window.getByRole("textbox", { name: "Era" })).toHaveValue("BE");
	await window.getByRole("button", { name: "Save World Clock" }).click();
	await expect(window.getByRole("button", { name: "Save World Clock" })).toBeDisabled();
	boxes = await manager(page);
	await boxes.getByRole("switch", { name: "World Clock in this Chat" }).click();
	await page.keyboard.press("Escape");
	await expect(window).not.toContainText("World Clock is off in this Chat.");
	await expect(window.getByRole("textbox", { name: "Era" })).toHaveValue("BE");

	boxes = await manager(page);
	await boxes.getByRole("button", { name: "Remove World Clock" }).click();
	await page.getByRole("dialog", { name: "Remove World Clock?" }).getByRole("button", { name: "Remove" }).click();
	await expect(window).toHaveCount(0);
	await expect(page.getByRole("button", { name: "World Clock", exact: true })).toHaveCount(0);
	await insertBox(page, "World Clock");
	await page.getByRole("button", { name: "World Clock", exact: true }).click();
	await expect(window.getByRole("textbox", { name: "Era" })).toHaveValue("AD");
});

test.describe("a Box lifecycle change from a stale read", () => {
	// The deliberate 409 conflict response logs one browser console error.
	test.use({ allowedBrowserErrors: /status of 409/ });

	test("Remove never deletes setup another tab saved while the confirmation was open", async ({ page, request }) => {
		await page.goto("/");
		await insertBox(page, "World Clock");
		const boxes = await manager(page);
		await boxes.getByRole("button", { name: "Remove World Clock" }).click();

		const { activeChatId } = await (await request.get("/api/workspace")).json();
		const { revision, boxSetups } = await (await request.get(`/api/conversations/${activeChatId}`)).json();
		const saved = await request.post(`/api/conversations/${activeChatId}/commands`, { data: {
			expectedRevision: revision, action: { type: "set-box-setup", box: "world-clock", setup: { ...boxSetups["world-clock"], era: "BE" } },
		} });
		expect(saved.ok()).toBe(true);

		await page.getByRole("dialog", { name: "Remove World Clock?" }).getByRole("button", { name: "Remove" }).click();
		await expect(page.getByRole("alert")).toHaveText("The Chat changed elsewhere; its Boxes were reloaded.");
		await expect(boxes.getByRole("listitem").filter({ hasText: "World Clock" })).toContainText("On");
		const after = await (await request.get(`/api/conversations/${activeChatId}`)).json();
		expect(after.boxes["world-clock"]).toBe("enabled");
		expect(after.boxSetups["world-clock"].era).toBe("BE");
	});
});

test("removing the Race after a Stretch keeps the story and its Moves, which reach the model as their labels", async ({ page, llm }) => {
	await llm.chat({ chunks: ["Race passage 1."] }, { chunks: ["The crowd disperses."] });
	await page.goto("/");
	await insertBox(page, "Race");
	await page.getByRole("button", { name: "Race", exact: true }).click();
	const window = page.getByRole("dialog", { name: "Race", exact: true });
	await window.getByRole("spinbutton", { name: "Distance (m)" }).fill("800");
	await window.getByRole("button", { name: "Fill field" }).click();
	await window.getByRole("radiogroup", { name: "Auto mode" }).getByRole("radio", { name: "Off" }).click();
	await window.getByRole("button", { name: "Start race" }).click();
	await window.getByRole("combobox", { name: "Order Runner" }).click();
	const option = page.getByRole("option").nth(1);
	const runner = await option.innerText();
	await option.click();
	await window.getByRole("region", { name: "Race Moves" }).getByRole("button", { name: /Overtake/ }).click();
	await page.getByRole("button", { name: "Generate Variant" }).click();
	await sendPlan(page, "Race passage 1.");
	const human = story(page).locator("article").nth(-2);
	const chips = human.getByRole("list", { name: "Race Moves" }).getByRole("listitem");
	await expect(chips).toHaveText([`⚡ Overtake · ${runner}`]);

	const boxes = await manager(page);
	await boxes.getByRole("button", { name: "Remove Race" }).click();
	await page.getByRole("dialog", { name: "Remove Race?" }).getByRole("button", { name: "Remove" }).click();
	await expect(window).toHaveCount(0);
	await expect(story(page).getByText("Race passage 1.")).toBeVisible();
	await expect(chips).toHaveText([`⚡ Overtake · ${runner}`]);

	await expect((await generate(page, "Walk home.")).getByText(/^Race ·/)).toHaveCount(0);
	await sendPlan(page, "The crowd disperses.");
	const sent = JSON.stringify((await llm.log()).calls.filter((call) => call.kind === "chat").at(-1));
	expect(sent).toContain(`⚡ Overtake · ${runner}`);
	expect(sent).not.toContain("(Race Move:");
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
		await expect(boxes.getByRole("switch", { name: `${title} in this Chat` })).not.toBeChecked();
		await expect(boxes.getByRole("listitem").filter({ hasText: title })).toContainText("Not in this Chat");
	}
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
