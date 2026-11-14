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

test("keep an Illustration in the Gallery after taking it off its Message, reuse its Brief, then remove it from the Gallery", async ({ page, llm }) => {
	await selectImageModel(page);
	await llm.chat({ chunks: ["A lantern beside the lake."] });
	await llm.images({ base64: picture });
	await page.goto("/");
	await send(page, "Show me the lantern.");
	const message = story(page).locator("article").last();
	await expect(message.getByText("A lantern beside the lake.")).toBeVisible();
	await message.hover();
	await message.getByRole("button", { name: "Paint", exact: true }).click();
	const panel = page.getByRole("complementary", { name: "Paint", exact: true });
	await panel.getByRole("textbox", { name: "Ask", exact: true }).fill("Lantern at the lake");
	await panel.getByRole("textbox", { name: "Brief", exact: true }).fill("A coral lantern reflected in still water.");
	await panel.getByRole("button", { name: "Paint", exact: true }).click();
	await panel.getByRole("button", { name: "Close Paint" }).click();
	await expect(story(page).getByRole("img", { name: "Illustration", exact: true })).toBeVisible();
	await story(page).getByRole("button", { name: "Illustration actions" }).click();
	await page.getByRole("menuitem", { name: "Remove, keep in Gallery" }).click();
	await expect(story(page).getByRole("img", { name: "Illustration", exact: true })).toHaveCount(0);
	await message.hover();
	await message.getByRole("button", { name: "Paint", exact: true }).click();
	await panel.getByRole("textbox", { name: "Brief", exact: true }).fill("");
	await panel.getByRole("textbox", { name: "Ask", exact: true }).fill("");
	await panel.getByRole("button", { name: "Picture actions: Lantern at the lake", exact: true }).click();
	await page.getByRole("menuitem", { name: "Use Brief", exact: true }).click();
	await expect(panel.getByRole("textbox", { name: "Brief", exact: true })).toHaveText("A coral lantern reflected in still water.");
	await expect(panel.getByRole("textbox", { name: "Ask", exact: true })).toHaveText("Lantern at the lake");
	await panel.getByRole("button", { name: "Picture actions: Lantern at the lake", exact: true }).click();
	await page.getByRole("menuitem", { name: "Remove from Gallery", exact: true }).click();
	await expect(panel.getByRole("button", { name: "Use as reference: Lantern at the lake", exact: true })).toHaveCount(0);
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
	await panel.getByText("Brief settings").click();
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

test.describe("References", () => {
	test.use({ allowedBrowserErrors: /status of 422/ });

	test("References survive writing a Brief again, persist in named Reference Sets and reach the Image Model after the Brief", async ({ page, llm }) => {
		await selectImageModel(page);
		const upload = async (width: number) => {
			const base64 = pngFixture({ width, height: 32 }).toString("base64");
			const image = await (await page.request.post("/api/images", { data: { data: base64 } })).json();
			return { hash: image.hash, base64 };
		};
		const cloak = await upload(40);
		const face = await upload(48);
		const portrait = await upload(64);
		const { activeChatId } = await (await page.request.get("/api/workspace")).json();
		const url = `/api/conversations/${activeChatId}`;
		const prompt = { systemInstruction: "", identity: "", appearance: `Silver hair. ![Face](image:${face.hash})`, scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
		const { revision } = await (await page.request.get(url)).json();
		expect((await page.request.post(`${url}/commands`, { data: { expectedRevision: revision, action: {
			type: "add-participant", definition: { name: "Iris", prompt, sendAppearanceImages: true, openings: [], portrait: { hash: portrait.hash, focalX: 0.5, focalY: 0.5 } },
		} } })).ok()).toBe(true);
		await llm.chat({ chunks: [`Iris in a red cloak. ![Red cloak](image:${cloak.hash})`] }, { chunks: ["Iris standing at the bridge."] });
		await llm.images({ base64: picture });
		await page.goto("/");
		await page.locator("form.composer").getByRole("button", { name: "Paint", exact: true }).click();
		const panel = page.getByRole("complementary", { name: "Paint", exact: true });
		const brief = panel.getByRole("textbox", { name: "Brief", exact: true });
		const references = panel.getByRole("textbox", { name: "References", exact: true });
		await references.fill("Iris: ");
		await panel.getByRole("button", { name: "Use as reference: Iris Portrait", exact: true }).click();
		await expect(references.locator(".image-chip")).toHaveText(["Iris Portrait"]);
		await panel.getByRole("textbox", { name: "Ask", exact: true }).fill("Paint Iris at the bridge.");
		await panel.getByRole("button", { name: "Write Brief", exact: true }).click();
		await expect(brief.locator(".image-chip")).toHaveText(["Red cloak"]);
		await panel.getByRole("button", { name: "Write Brief", exact: true }).click();
		await expect(brief).toHaveText("Iris standing at the bridge.");
		await expect(references.locator(".image-chip")).toHaveText(["Iris Portrait"]);
		await panel.getByRole("button", { name: "Paint", exact: true }).click();
		await expect(panel.getByRole("img", { name: "Illustration", exact: true })).toBeVisible();
		const sent = (await llm.log()).calls.find((call) => call.kind === "image");
		expect(sent?.body).toMatchObject({ prompt: "Iris standing at the bridge.\n\n---\n\nIris: [Image: Iris Portrait]" });
		expect(sent?.body.input_references?.map((reference) => reference.image_url.url)).toEqual([`data:image/png;base64,${portrait.base64}`]);
		await expect(panel.getByRole("figure", { name: "Illustration" })).toContainText("e2e-painter · 1:1");

		await panel.getByRole("button", { name: "New", exact: true }).click();
		await panel.getByRole("textbox", { name: "Reference Set name", exact: true }).fill("Kimono");
		await panel.getByRole("button", { name: "Create", exact: true }).click();
		const picker = panel.getByRole("combobox", { name: "Reference Set", exact: true });
		await expect(picker).toHaveText("Kimono");
		await expect(references.locator(".image-chip")).toHaveText(["Iris Portrait"]);
		await references.fill("Iris: kimono");
		await panel.getByRole("button", { name: "Close Paint" }).click();
		await expect.poll(async () => (await (await page.request.get(`${url}/illustrations`)).json()).referenceSets.map(({ name, references }: { name: string; references: string }) => `${name}=${references}`))
			.toEqual(["Kimono=Iris: kimono", `References=Iris: ![Iris Portrait](image:${portrait.hash})`]);
		await page.reload();
		await page.locator("form.composer").getByRole("button", { name: "Paint", exact: true }).click();
		await expect(picker).toHaveText("Kimono");
		await expect(references).toHaveText("Iris: kimono");
		await picker.click();
		await page.getByRole("option", { name: "References", exact: true }).click();
		await expect(references.locator(".image-chip")).toHaveText(["Iris Portrait"]);
		await story(page).getByRole("button", { name: "Illustration actions" }).click();
		await page.getByRole("menuitem", { name: "Edit Brief and repaint" }).click();
		await expect(brief).toHaveText("Iris standing at the bridge.");
		await expect(picker).toHaveText("References");

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
