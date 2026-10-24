import { test, expect, insertBox, story, openBoxes, closeBoxes } from "../../../e2e/fixtures";

test("Memory inspector, settings and participant identity stay available while Memory is off", async ({ page, request }) => {
	await page.goto("/");
	const tools = page.getByRole("group", { name: "Chat tools" });
	await tools.getByRole("button", { name: "Memories", exact: true }).click();
	await expect(page.getByRole("complementary", { name: "Memories" })).toBeVisible();
	await openBoxes(page);
	await page.getByRole("switch", { name: "Memory in this Chat" }).click();
	await closeBoxes(page);
	await expect(tools.getByRole("button", { name: "Memories", exact: true })).toBeVisible();
	await tools.getByRole("button", { name: "Memories", exact: true }).click();
	await expect(page.getByRole("complementary", { name: "Memories" })).toContainText("Memory is off in this Chat.");
	const message = story(page).getByRole("article").last();
	await message.hover();
	await message.getByRole("button", { name: "Memories", exact: true }).click();
	await expect(page.getByRole("complementary", { name: "Memories" }).getByRole("button", { name: "Remember this Message" })).toBeDisabled();

	await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Memory", exact: true }).click();
	await page.getByRole("spinbutton", { name: "Context limit", exact: true }).fill("4096");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
	expect((await (await request.get("/api/boxes/memory/settings")).json()).contextLimit).toBe(4096);
	await page.getByRole("button", { name: "Close Memory", exact: true }).click();

	await page.getByRole("button", { name: "Cast", exact: true }).click();
	await page.getByRole("region", { name: "In this chat" }).getByRole("button", { name: /^Theodora Kline/ }).click();
	await page.getByRole("region", { name: "Memory", exact: true }).getByRole("button", { name: "Change…" }).click();
	const identity = page.getByRole("dialog", { name: "Theodora Kline in the story" });
	await identity.getByRole("radio", { name: "Not in the story", exact: true }).click();
	await identity.getByRole("button", { name: "Apply", exact: true }).click();
	await expect(page.getByRole("region", { name: "Memory", exact: true })).toContainText("Not in the story");
	await page.getByRole("button", { name: "Close Characters", exact: true }).click();
	await insertBox(page, "Memory");
	await tools.getByRole("button", { name: "Memories", exact: true }).click();
	await page.getByRole("button", { name: "More Memory actions" }).click();
	await page.getByRole("menuitem", { name: "Memory Settings" }).click();
	await expect(page.getByRole("spinbutton", { name: "Context limit", exact: true })).toHaveValue("4096");
});

test("Memory traces render in previews, active Generations and saved details even after disabling the Box", async ({ page, llm }) => {
	await llm.chat({ chunks: ["The lantern stays lit.\n\n", "Then"], hold: true });
	await page.goto("/");
	await page.getByRole("textbox", { name: "Message draft" }).fill("Watch the lantern.");
	await page.getByRole("button", { name: "Generate Variant" }).click();
	const preview = page.getByRole("complementary", { name: "Prompt Plan preview" });
	await expect(preview.getByRole("heading", { name: "Memory recall" })).toBeVisible();
	await preview.getByRole("button", { name: "Send exact plan" }).click();
	await expect(story(page).getByText("The lantern stays lit.")).toBeVisible();
	await page.getByRole("button", { name: "Inspect Generation", exact: true }).click();
	const details = page.getByRole("complementary", { name: "Generation details" });
	await expect(details.getByRole("heading", { name: "Memory recall" })).toBeVisible();
	await llm.release();
	await expect(page.getByRole("button", { name: "Generate Variant" })).toBeVisible();
	await details.getByRole("button", { name: "Close Generation inspection" }).click();
	const reply = story(page).locator("article", { hasText: "The lantern stays lit." });
	await reply.hover();
	await reply.getByRole("button", { name: "Details", exact: true }).click();
	await expect(details.getByRole("heading", { name: "Memory recall" })).toBeVisible();
	await openBoxes(page);
	await page.getByRole("switch", { name: "Memory in this Chat" }).click();
	await closeBoxes(page);
	await reply.hover();
	await reply.getByRole("button", { name: "Details", exact: true }).click();
	await expect(details.getByRole("heading", { name: "Memory recall" })).toBeVisible();
});
