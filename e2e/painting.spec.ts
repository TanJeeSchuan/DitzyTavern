import { isChatModelCall } from "./protocol";
import type { Page } from "@playwright/test";
import { test, expect, send, story } from "./fixtures";
import { pngFixture } from "../src/server/image/image-fixtures";

const picture = pngFixture({ width: 640, height: 480 }).toString("base64");

const selectImageModel = async (page: Page) => {
	const settings = await (await page.request.get("/api/connection-settings")).json();
	const { presets } = await (await page.request.get("/api/connection-settings/presets")).json();
	const profile = presets.find((entry: { id: string }) => entry.id === "openrouter-images").profile;
	const created = await (await page.request.post("/api/connection-settings/commands", { data: { type: "create-profile", expectedRevision: settings.revision, profile } })).json();
	const profileId = created.settings.profiles.find((entry: { displayName: string }) => entry.displayName === profile.displayName).id;
	await page.request.post("/api/image-model/commands", { data: { type: "apply", expectedRevision: 0, profileId, model: "e2e-painter" } });
};

test("paint a typed Brief, swipe away and back, then retry a provider refusal", async ({ page, llm }) => {
	await selectImageModel(page);
	await llm.chat({ chunks: ["A lantern beside the lake."] }, { chunks: ["A lantern inside the house."] });
	await llm.images({ base64: picture }, { status: 400, error: "This Brief was refused by the painter." }, { base64: picture });
	await page.goto("/");
	await send(page, "Show me the lantern.");
	const message = story(page).locator("article").last();
	await expect(message.getByText("A lantern beside the lake.")).toBeVisible();
	await message.hover();
	await message.getByRole("button", { name: "Paint", exact: true }).click();
	const panel = page.getByRole("complementary", { name: "Paint", exact: true });
	await panel.getByRole("textbox", { name: "Brief", exact: true }).fill("A coral lantern reflected in still water.");
	await panel.getByRole("button", { name: "Paint", exact: true }).click();
	await panel.getByRole("button", { name: "Close Paint" }).click();
	await expect(story(page).getByRole("img", { name: "Illustration", exact: true })).toBeVisible();
	await message.hover();
	await message.getByRole("button", { name: "New Swipe", exact: true }).last().click();
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(message.getByText("A lantern inside the house.")).toBeVisible();
	await expect(story(page).getByRole("img", { name: "Illustration", exact: true })).toHaveCount(0);
	await message.getByRole("button", { name: "Previous Swipe" }).click();
	await expect(story(page).getByRole("img", { name: "Illustration", exact: true })).toBeVisible();
	await message.hover();
	await message.getByRole("button", { name: "Paint", exact: true }).click();
	await panel.getByRole("textbox", { name: "Brief", exact: true }).fill("Another lantern.");
	await panel.getByRole("button", { name: "Paint", exact: true }).click();
	await panel.getByRole("button", { name: "Close Paint" }).click();
	await expect(story(page).getByText("This Brief was refused by the painter.")).toBeVisible();
	await story(page).getByRole("button", { name: "Retry", exact: true }).click();
	await expect(story(page).getByRole("img", { name: "Illustration", exact: true })).toHaveCount(2);
	await page.reload();
	await expect(story(page).getByRole("img", { name: "Illustration", exact: true })).toHaveCount(2);
});

test("painting reaches the story model only after Add to composer and Send", async ({ page, llm }) => {
	await selectImageModel(page);
	await llm.chat({ chunks: ["The lantern lights the lake.\n\n" + "The water reflects the hills as the lantern sways in the wind. ".repeat(40)] }, { chunks: ["I see your Illustration."] });
	await llm.images({ base64: picture });
	await page.goto("/");
	await page.locator("form.composer").getByRole("button", { name: "Paint", exact: true }).click();
	const panel = page.getByRole("complementary", { name: "Paint", exact: true });
	await panel.getByRole("textbox", { name: "Brief", exact: true }).fill("A lantern on a moonlit lake.");
	await panel.getByRole("button", { name: "Paint", exact: true }).click();
	await panel.getByRole("button", { name: "Close Paint" }).click();
	const illustration = story(page).getByRole("figure", { name: "Illustration", exact: true });
	await expect(illustration.getByRole("img", { name: "Illustration", exact: true })).toBeVisible();
	await send(page, "Look across the lake.");
	await expect(story(page).getByText("The lantern lights the lake.")).toBeVisible();
	await illustration.getByRole("button", { name: "Add to composer", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "Message draft" }).locator(".image-chip")).toHaveText("Illustration");
	await page.getByRole("button", { name: "Generate Variant" }).click();
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(story(page).getByText("I see your Illustration.")).toBeVisible();
	const calls = (await llm.log()).calls.filter(isChatModelCall);
	expect(calls).toHaveLength(2);
	expect(JSON.stringify(calls[0]!.body.messages)).not.toContain("image_url");
	const sent = calls[1]!.body.messages.flatMap(({ content }) => Array.isArray(content) ? content : []);
	expect(sent.filter((part) => part.type === "image_url")).toEqual([{ type: "image_url", image_url: { url: `data:image/png;base64,${picture}` } }]);
	expect(sent).toContainEqual({ type: "text", text: expect.stringContaining("[Image: Illustration]") });
});

test("write a Brief from an Ask on an older Message, edit it and paint", async ({ page, llm }) => {
	await selectImageModel(page);
	await llm.chat({ chunks: ["A lantern beside the bridge."] }, { chunks: ["Later, the bridge is empty."] }, { chunks: ["A green lantern", " reflected under a stone bridge."] });
	await llm.images({ base64: picture });
	await page.goto("/");
	await send(page, "Visit the bridge.");
	await expect(story(page).getByText("A lantern beside the bridge.")).toBeVisible();
	await send(page, "Leave the bridge.");
	await expect(story(page).getByText("Later, the bridge is empty.")).toBeVisible();
	const older = story(page).locator("article").filter({ hasText: "A lantern beside the bridge." });
	await older.hover();
	await older.getByRole("button", { name: "Paint", exact: true }).click();
	const panel = page.getByRole("complementary", { name: "Paint", exact: true });
	await panel.getByRole("textbox", { name: "Ask", exact: true }).fill("Focus on the reflection.");
	await panel.getByRole("spinbutton", { name: "Messages", exact: true }).fill("2");
	await panel.getByRole("spinbutton", { name: "Messages", exact: true }).press("Enter");
	await expect(panel.getByRole("textbox", { name: "Brief", exact: true })).toHaveText("A green lantern reflected under a stone bridge.");
	await panel.getByRole("textbox", { name: "Brief", exact: true }).fill("A red lantern reflected under a stone bridge.");
	await panel.getByRole("button", { name: "Paint", exact: true }).click();
	await expect(panel.getByRole("img", { name: "Illustration", exact: true })).toBeVisible();
	const calls = (await llm.log()).calls.filter(isChatModelCall);
	expect(calls.at(-1)!.body.messages.at(-1)).toMatchObject({ role: "user", content: "Focus on the reflection." });
	const sent = JSON.stringify(calls.at(-1)!.body.messages);
	expect(sent).toContain("A lantern beside the bridge.");
	expect(sent).toContain("Write a short description of the scene for an image model.");
	expect(sent).not.toContain("Later, the bridge is empty.");
	expect(sent).not.toContain("You arrive as she pins a third map over the first two.");
	expect((await llm.log()).calls.find((call) => call.kind === "image")?.body).toMatchObject({ prompt: "A red lantern reflected under a stone bridge." });
});

test.describe("Brief References", () => {
	test.use({ allowedBrowserErrors: /status of 422/ });

test("rewrite a Brief, keep a gallery Reference, recompute Cast Appearance and paint exactly the edited References", async ({ page, llm }) => {
	await selectImageModel(page);
	const upload = async (width: number) => {
		const base64 = pngFixture({ width, height: 32 }).toString("base64");
		const image = await (await page.request.post("/api/images", { data: { data: base64 } })).json();
		return { hash: image.hash, base64 };
	};
	const old = await upload(40);
	const face = await upload(48);
	const coat = await upload(56);
	const gallery = await upload(64);
	const { activeChatId } = await (await page.request.get("/api/workspace")).json();
	const url = `/api/conversations/${activeChatId}`;
	const prompt = { systemInstruction: "", identity: "", appearance: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
	for (const [name, appearance, portrait] of [
		["Iris", `Silver hair. ![Face](image:${face.hash}) ![Coat](image:${coat.hash})`, { hash: gallery.hash, focalX: 0.5, focalY: 0.5 }],
		["Old", `Red cloak. ![Red cloak](image:${old.hash})`, undefined],
	] as const) {
		const { revision } = await (await page.request.get(url)).json();
		const added = await page.request.post(`${url}/commands`, { data: { expectedRevision: revision, action: {
			type: "add-participant", definition: { name, prompt: { ...prompt, appearance }, sendAppearanceImages: true, openings: [], portrait },
		} } });
		expect(added.ok()).toBe(true);
	}
	await llm.chat({ chunks: [`Old in a red cloak. ![Red cloak](image:${old.hash}) ![Duplicate](image:${old.hash})`] }, { chunks: ["Iris standing at the bridge."] });
	await llm.images({ base64: picture });
	await page.goto("/");
	await page.locator("form.composer").getByRole("button", { name: "Paint", exact: true }).click();
	const panel = page.getByRole("complementary", { name: "Paint", exact: true });
	await panel.getByRole("textbox", { name: "Ask", exact: true }).fill("Paint Iris at the bridge in daylight.");
	await panel.getByRole("button", { name: "Write Brief", exact: true }).click();
	const brief = panel.getByRole("textbox", { name: "Brief", exact: true });
	await expect(brief.locator(".image-chip")).toHaveText(["Red cloak"]);
	await panel.getByRole("button", { name: "Use as reference: Iris Portrait", exact: true }).click();
	await panel.getByRole("button", { name: "Write Brief", exact: true }).click();
	await expect(brief.locator(".image-chip")).toHaveText(["Face", "Coat", "Iris Portrait"]);
	await brief.press("ControlOrMeta+Home");
	await brief.press("ArrowDown");
	await brief.press("ArrowDown");
	await brief.press("Home");
	await brief.press("Delete");
	await expect(brief.locator(".image-chip")).toHaveText(["Coat", "Iris Portrait"]);
	await panel.getByRole("button", { name: "Paint", exact: true }).click();
	await expect(panel.getByRole("img", { name: "Illustration", exact: true })).toBeVisible();
	const sent = (await llm.log()).calls.find((call) => call.kind === "image");
	expect(sent?.body.input_references?.map((reference) => reference.image_url.url)).toContain(`data:image/png;base64,${gallery.base64}`);
	expect(sent?.body.input_references?.map((reference) => reference.image_url.url)).not.toContain(`data:image/png;base64,${old.base64}`);
	expect(sent?.body.input_references?.map((reference) => reference.image_url.url)).toEqual([coat, gallery].map(({ base64 }) => `data:image/png;base64,${base64}`));
	await panel.getByRole("button", { name: "Add to composer", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "Message draft" }).locator(".image-chip")).toHaveText("Paint Iris at the bridge in");
	const unchanged = await brief.innerText();
	await llm.chat({ status: 429, error: "Brief quota exceeded" });
	await panel.getByRole("button", { name: "Write Brief", exact: true }).click();
	await expect(panel.getByRole("alert")).toBeVisible();
	expect(await brief.innerText()).toBe(unchanged);
	await llm.chat({ chunks: [], hold: true });
	await panel.getByRole("button", { name: "Write Brief", exact: true }).click();
	await panel.getByRole("button", { name: "Stop", exact: true }).click();
	await expect(panel.getByRole("button", { name: "Write Brief", exact: true })).toBeEnabled();
	expect(await brief.innerText()).toBe(unchanged);
	await llm.release();
});

});
