import type { Page } from "@playwright/test";
import { test, expect, insertBox, story, openBoxes as manager, closeBoxes } from "../../../e2e/fixtures";

const generate = async (page: Page, text: string) => {
	const composer = page.getByRole("textbox", { name: "Message draft" });
	await expect(composer).toHaveAttribute("contenteditable", "true");
	await composer.fill(text);
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
	await expect(boxes.getByRole("listitem").filter({ hasText: "Phone" })).toContainText("No unread texts");
	await boxes.getByRole("button", { name: "Phone", exact: true }).click();
	await expect(window).toBeVisible();
	await window.getByRole("button", { name: "Minimize Phone" }).click();
	await expect(dock).toBeVisible();
	await closeBoxes(page);
	await expect(page.getByRole("button", { name: "Phone", exact: true })).toHaveCount(0);
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
