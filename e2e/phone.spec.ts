import { test, expect, story, insertBox } from "./fixtures";

const sms = (from: string, to: string, text: string) => `<sms from="${from}" to="${to}">${text}</sms>`;

test("a text in a reply moves from the prose to the Phone, counts as unread, and follows a swipe", async ({ page, llm }) => {
	await llm.chat(
		{ chunks: [`Theodora glances at her screen.\n${sms("Theodora Kline", "Night Desk", "u still up?")}\nShe waits.`] },
		{ chunks: [`Theodora sets the phone face down.\n${sms("Theodora Kline", "Night Desk", "nvm, sleep well")}`] },
	);
	await page.goto("/");
	await insertBox(page, "Phone");
	await page.getByRole("button", { name: "Phone", exact: true }).click();
	const phone = page.getByRole("dialog", { name: "Phone" });
	const thread = phone.getByRole("list", { name: "Texts with Theodora Kline" });
	await expect(thread).toContainText("No texts with Theodora Kline yet.");
	await phone.getByRole("button", { name: "Minimize Phone" }).click();
	const dock = page.getByRole("button", { name: /^Phone: / });
	await expect(dock).toContainText("No unread texts");

	await page.getByRole("textbox", { name: "Message draft" }).fill("The night is quiet.");
	await page.getByRole("button", { name: "Generate Variant" }).click();
	await page.getByRole("button", { name: "Send exact plan" }).click();
	const reply = story(page).locator("article").last();
	await expect(reply.getByText("She waits.")).toBeVisible();
	await expect(reply).not.toContainText("u still up?");
	await expect(reply.getByRole("button", { name: "Theodora Kline texted Night Desk" })).toBeVisible();
	await expect(dock).toContainText("1 unread");

	await dock.click();
	await expect(thread.getByRole("listitem")).toHaveText(["u still up?"]);
	await phone.getByRole("button", { name: "Minimize Phone" }).click();
	await expect(dock).toContainText("No unread texts");

	await reply.getByRole("button", { name: "New Swipe" }).click();
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(story(page).getByText("Theodora sets the phone face down.")).toBeVisible();
	await expect(dock).toContainText("1 unread");
	await reply.getByRole("button", { name: "Theodora Kline texted Night Desk" }).click();
	await expect(thread.getByRole("listitem")).toHaveText(["nvm, sleep well"]);
});

test("a text staged from the Phone is a turn on its own, sent to the model as markup", async ({ page, llm }) => {
	await llm.chat({ chunks: ["Theodora reads it and smiles."] });
	await page.goto("/");
	await insertBox(page, "Phone");
	await page.getByRole("button", { name: "Phone", exact: true }).click();
	const phone = page.getByRole("dialog", { name: "Phone" });
	const thread = phone.getByRole("list", { name: "Texts with Theodora Kline" });
	await phone.getByRole("textbox", { name: "Text Theodora Kline" }).fill("u up?");
	await phone.getByRole("button", { name: "Stage text" }).click();
	await expect(thread.getByRole("listitem")).toHaveText(["u up?Staged"]);
	const composer = page.locator("form.composer");
	await expect(composer.getByRole("list", { name: "Phone Moves" }).getByRole("listitem")).toHaveText(["📱 Theodora Kline: u up?"]);

	await page.getByRole("button", { name: "Generate Variant" }).click();
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(story(page).getByText("Theodora reads it and smiles.")).toBeVisible();
	const human = story(page).locator("article").nth(-2);
	await expect(human.getByRole("list", { name: "Phone Moves" }).getByRole("listitem")).toHaveText(["📱 Theodora Kline: u up?"]);
	await expect(composer.getByRole("list", { name: "Phone Moves" })).toHaveCount(0);
	await expect(thread.getByRole("listitem")).toHaveText(["u up?"]);
	const [sent] = (await llm.log()).calls.filter((call) => call.kind === "chat");
	expect(JSON.stringify(sent)).toContain(JSON.stringify(sms("Night Desk", "Theodora Kline", "u up?")).slice(1, -1));
});

test("a seat change drops staged texts for good", async ({ page }) => {
	await page.goto("/");
	await insertBox(page, "Phone");
	await page.getByRole("button", { name: "Phone", exact: true }).click();
	const phone = page.getByRole("dialog", { name: "Phone" });
	await phone.getByRole("textbox", { name: "Text Theodora Kline" }).fill("u up?");
	await phone.getByRole("button", { name: "Stage text" }).click();
	const staged = page.locator("form.composer").getByRole("list", { name: "Phone Moves" });
	await expect(staged.getByRole("listitem")).toHaveText(["📱 Theodora Kline: u up?"]);
	const writeAs = async (name: string) => {
		await page.getByRole("combobox", { name: "Writing as" }).click();
		await page.getByRole("option", { name: new RegExp(`^${name}`) }).click();
		await expect(page.getByRole("combobox", { name: "Writing as" })).toContainText(name);
	};
	await writeAs("Theodora Kline");
	await expect(staged).toHaveCount(0);
	await writeAs("Night Desk");
	await expect(staged).toHaveCount(0);
});

test("the Phone block's instructions are edited in the preset and sent before the contacts", async ({ page, llm }) => {
	await llm.chat({ chunks: ["Theodora checks her phone."] });
	await page.goto("/");
	await insertBox(page, "Phone");
	await page.getByRole("button", { name: "Prompt Presets" }).click();
	await page.getByRole("button", { name: "Edit Phone" }).click();
	const editor = page.getByRole("dialog", { name: "Phone" });
	const instructions = editor.getByRole("textbox", { name: "Instructions" });
	await expect(instructions).toHaveValue(/^Write each text on its own line as <sms from="\{\{other\}\}"/);
	await instructions.fill(`Texts look like ${sms("{{other}}", "{{self}}", "hi")}.`);
	await editor.getByRole("button", { name: "Done" }).click();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

	await page.getByRole("textbox", { name: "Message draft" }).fill("The night is quiet.");
	await page.getByRole("button", { name: "Generate Variant" }).click();
	const preview = page.getByRole("complementary", { name: "Prompt Plan preview" });
	await preview.getByText(/^Phone ·/).click();
	await expect(preview.getByRole("textbox", { name: /^box:phone block/ }).locator(".cm-line")).toHaveText([
		`Texts look like ${sms("Theodora Kline", "Night Desk", "hi")}.`,
		"Night Desk has a phone and can text Theodora Kline.",
	]);
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(story(page).getByText("Theodora checks her phone.")).toBeVisible();
});
