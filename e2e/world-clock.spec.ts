import type { Locator, Page } from "@playwright/test";
import { test, expect, selectBoxDecisionModel, insertBox, send, story, openBoxes, closeBoxes } from "./fixtures";
import type { E2eServer } from "./harness";
import { hasDecisionPassage, isDecisionModelCall } from "./protocol";

const elapsed = ["none", "~5m", "~15m", "~30m", "~1h", "~2h", "~4h", "~8h", "overnight", "~1 day", "several days"];
const weather = ["not mentioned", "clear", "cloudy", "rain", "storm", "snow", "fog"];
const choice = (selected: string, labels: string[]) => ({
	type: "choice" as const, choice: selected,
	probabilities: Object.fromEntries(labels.map((label) => [label, label === selected ? 0.9 : 0.1 / (labels.length - 1)])),
});
const digest = (passage: string | undefined, bin: string, established: string, hold = false) => [
	{ passage, match: ["How much in-world time passes"], answer: choice(bin, elapsed), hold },
	{ passage, match: ["What weather does"], answer: choice(established, weather), hold },
];

const digested = (llm: E2eServer, passage: string) => expect.poll(async () => (await llm.log()).calls
	.some((call) => isDecisionModelCall(call) && hasDecisionPassage(call.body.state) && JSON.stringify(call.body.state.passage).includes(passage))).toBe(true);

const clockLine = async (page: Page) => {
	const preview = page.getByRole("complementary", { name: "Prompt Plan preview" });
	await preview.getByText(/^World Clock ·/).click();
	return preview.getByRole("textbox").filter({ hasText: "🗓️" });
};

const sendWithClock = async (page: Page, text: string) => {
	const composer = page.getByRole("textbox", { name: "Message draft" });
	await expect(composer).toHaveAttribute("contenteditable", "true");
	await composer.fill(text);
	await page.getByRole("button", { name: "Generate Variant" }).click();
	return clockLine(page);
};

const openWorldClock = async (page: Page) => {
	await page.getByRole("button", { name: "World Clock", exact: true }).click();
	return page.getByRole("dialog", { name: "World Clock" });
};

const enableClock = async (page: Page) => {
	await insertBox(page, "World Clock");
	const window = await openWorldClock(page);
	await window.getByRole("button", { name: "Minimize World Clock" }).click();
};

const dockTab = (page: Page) => page.getByRole("toolbar", { name: "Minimized Boxes" }).getByRole("button", { name: /^World Clock: / });
const topBarItem = (page: Page) => page.getByRole("group", { name: "Chat tools" }).getByRole("button", { name: /^World Clock: / });

test("the World Clock digests passages in the background and follows the selected Variant", async ({ page, request, llm }) => {
	await selectBoxDecisionModel(request, "world-clock");
	await llm.decisions(
		...digest("The storm breaks", "overnight", "storm"),
		...digest("Snow drifts", "~2h", "snow"),
		...digest(undefined, "none", "not mentioned"),
	);
	await llm.chat(
		{ chunks: ["The storm breaks over the tower at dusk."] },
		{ chunks: ["Snow drifts against the shutters."] },
		{ chunks: ["She lights the lamp."] },
		{ chunks: ["She keeps watch."] },
	);
	await page.goto("/");
	await enableClock(page);
	const send = page.getByRole("button", { name: "Send exact plan" });

	await expect(await sendWithClock(page, "Wait out the night.")).toHaveText("8:00 AM | 🗓️ Sunday, June 1, 2025 AD");
	await send.click();
	await expect(story(page).locator("article").getByText("The storm breaks")).toBeVisible();
	const reply = story(page).locator("article").nth(await story(page).locator("article").count() - 1);
	await digested(llm, "Wait out the night.");
	await digested(llm, "The storm breaks");

	await reply.getByRole("button", { name: "New Swipe" }).click();
	await expect(await clockLine(page)).toHaveText("8:00 AM | 🗓️ Sunday, June 1, 2025 AD");
	await send.click();
	await expect(reply.getByText("Snow drifts")).toBeVisible();
	await digested(llm, "Snow drifts");

	await expect(await sendWithClock(page, "Look outside.")).toHaveText(/^(9|10):\d\d AM \| 🗓️ Sunday, June 1, 2025 AD \| 🌨️ Snow, -?\d+°C$/);
	await send.click();
	await expect(story(page).locator("article").getByText("She lights the lamp.")).toBeVisible();
	await digested(llm, "She lights the lamp.");

	await reply.hover();
	await reply.getByRole("button", { name: "Previous Swipe" }).click();
	await page.getByRole("status", { name: "Swipe preview" }).getByRole("button", { name: "Confirm" }).click();
	await expect(reply.getByText("The storm breaks")).toBeVisible();
	await expect(await sendWithClock(page, "And now?")).toHaveText(/^\d+:\d\d PM \| 🗓️ Sunday, June 1, 2025 AD \| ⛈️ Storm, -?\d+°C$/);
	await send.click();
	await expect(story(page).locator("article").getByText("She keeps watch.")).toBeVisible();
	await digested(llm, "She keeps watch.");
});

test("the dock tab and the top bar item follow a digest that lands while the window is minimized, and the item opens it", async ({ page, request, llm }) => {
	await selectBoxDecisionModel(request, "world-clock");
	await llm.decisions(
		...digest("Wait out the night.", "overnight", "clear"),
		...digest("Dawn comes", "~1h", "clear"),
	);
	await llm.chat({ chunks: ["Dawn comes over the water."] });
	await page.goto("/");
	await enableClock(page);
	await expect(dockTab(page)).toHaveText("World Clock: 8:00 AM");
	await expect(topBarItem(page)).toHaveText("World Clock: 8:00 AM");

	await sendWithClock(page, "Wait out the night.");
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(story(page).locator("article").getByText("Dawn comes")).toBeVisible();
	await digested(llm, "Wait out the night.");
	await digested(llm, "Dawn comes");

	await expect(dockTab(page)).toHaveText(/^World Clock: \d{1,2}:\d\d PM( · .+)?$/, { timeout: 15_000 });
	await expect(topBarItem(page)).toHaveText(/^World Clock: \d{1,2}:\d\d PM( · .+)?$/, { timeout: 15_000 });
	await topBarItem(page).click();
	await expect(page.getByRole("dialog", { name: "World Clock" })).toBeVisible();
	await expect(dockTab(page)).toHaveCount(0);
});

test("a clock that is off contributes no clock line and queues no digest", async ({ page, request, llm }) => {
	await selectBoxDecisionModel(request, "world-clock");
	await llm.chat({ chunks: ["The lamp turns above you."] });
	await page.goto("/");
	const composer = page.getByRole("textbox", { name: "Message draft" });
	await expect(composer).toHaveAttribute("contenteditable", "true");
	await composer.fill("Look outside.");
	await page.getByRole("button", { name: "Generate Variant" }).click();
	const preview = page.getByRole("complementary", { name: "Prompt Plan preview" });
	await expect(preview.getByText(/^World Clock ·/)).toHaveCount(0);
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(story(page).locator("article").getByText("The lamp turns above you.")).toBeVisible();
	expect((await llm.log()).calls.some((call) => isDecisionModelCall(call))).toBe(false);
});

test("a reinserted clock starts from its initial time while a re-enabled one keeps its digested time", async ({ page, request, llm }) => {
	await selectBoxDecisionModel(request, "world-clock");
	await llm.decisions(
		...digest("Wait out the night.", "overnight", "clear"),
		...digest("Dawn comes", "~1h", "clear"),
	);
	await llm.chat({ chunks: ["Dawn comes over the water."] });
	await page.goto("/");
	await enableClock(page);
	await expect(await sendWithClock(page, "Wait out the night.")).toHaveText("8:00 AM | 🗓️ Sunday, June 1, 2025 AD");
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(story(page).locator("article").getByText("Dawn comes")).toBeVisible();
	await expect(dockTab(page)).toHaveText(/^World Clock: \d{1,2}:\d\d PM/, { timeout: 15_000 });

	const toggle = async (action: (boxes: Locator) => Promise<void>) => {
		await openBoxes(page);
		await action(page.getByRole("list", { name: "Boxes" }));
		await closeBoxes(page);
	};
	const clockSwitch = (boxes: Locator) => boxes.getByRole("switch", { name: "World Clock in this Chat" });
	const cancelPreview = () => page.getByRole("complementary", { name: "Prompt Plan preview" }).getByRole("button", { name: "Cancel" }).click();

	await toggle((boxes) => clockSwitch(boxes).click());
	await expect(topBarItem(page)).toHaveText(/^World Clock: \d{1,2}:\d\d PM/);
	await toggle((boxes) => clockSwitch(boxes).click());
	await expect(topBarItem(page)).toHaveText(/^World Clock: \d{1,2}:\d\d PM/);
	await expect(await sendWithClock(page, "Look outside.")).toHaveText(/^\d{1,2}:\d\d PM \| 🗓️ Sunday, June 1, 2025 AD \| .+ Clear, -?\d+°C$/);
	await cancelPreview();

	await toggle(async (boxes) => {
		await boxes.getByRole("button", { name: "Remove World Clock" }).click();
		await page.getByRole("dialog", { name: "Remove World Clock?" }).getByRole("button", { name: "Remove" }).click();
	});
	await insertBox(page, "World Clock");
	await expect(await sendWithClock(page, "Look outside.")).toHaveText("8:00 AM | 🗓️ Sunday, June 1, 2025 AD");
	await cancelPreview();
});

test("window layout and setup stay with their Chat", async ({ page }) => {
	await page.goto("/");
	await enableClock(page);
	await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Chats", exact: true }).click();
	await page.getByRole("button", { name: /^The Lantern House/ }).click();
	await expect(dockTab(page)).toHaveCount(0);
	await expect(page.getByRole("button", { name: "World Clock", exact: true })).toHaveCount(0);
});

test("a Writer override survives a late digest, reset restores the automatic value, and catch-up digests an existing path", async ({ page, request, llm }) => {
	await selectBoxDecisionModel(request, "world-clock");
	await llm.chat(
		{ chunks: ["The storm breaks over the tower."] },
		{ chunks: ["Snow drifts against the shutters."] },
	);
	await page.goto("/");
	await send(page, "Wait out the night.");
	await expect(story(page).locator("article").getByText("The storm breaks")).toBeVisible();
	await send(page, "Look outside.");
	await expect(story(page).locator("article").getByText("Snow drifts")).toBeVisible();
	const { activeChatId } = await (await request.get("/api/workspace")).json();

	await insertBox(page, "World Clock");
	const window = await openWorldClock(page);
	const passage = (text: string) => window.getByRole("listitem").filter({ hasText: text });
	await expect(passage("The storm breaks")).toContainText("Not read yet");

	await passage("The storm breaks").hover();
	await passage("The storm breaks").getByRole("button", { name: "Edit" }).click();
	await passage("The storm breaks").getByRole("spinbutton", { name: "Minutes" }).fill("5");
	await passage("The storm breaks").getByRole("combobox", { name: "Weather" }).click();
	await page.getByRole("option", { name: "☀️ Clear" }).click();
	await passage("The storm breaks").getByRole("button", { name: "Save override" }).click();
	await expect(passage("The storm breaks")).toContainText("+5m · ☀️ Clear");
	await expect(passage("The storm breaks")).toContainText("Overridden");

	await llm.decisions(
		...digest("Wait out the night.", "none", "not mentioned"),
		...digest("The storm breaks", "overnight", "storm"),
		...digest("Look outside.", "none", "not mentioned"),
		...digest("Snow drifts", "~2h", "snow"),
		// @approved
		//  The seeded Chat's own passages are part of the catch-up path too; a
		//  passage-less rule last reads them as spending no time.
		...digest(undefined, "none", "not mentioned"),
	);
	await window.getByRole("button", { name: "Digest missing passages" }).click();
	// @approved
	//  The catch-up run is done only when the read reports no run and its
	//  stored automatic matches every passage's current text, so the late
	//  digest has landed before the override is checked again.
	await expect.poll(async () => {
		const read = await (await request.get(`/api/conversations/${activeChatId}/boxes/world-clock`)).json();
		return read.catchUp === null && read.passages.every((entry: { digested: boolean }) => entry.digested);
	}, { timeout: 15_000 }).toBe(true);
	await expect(passage("Wait out the night.")).toContainText("No time passes");
	await expect(passage("The storm breaks")).toContainText("+5m · ☀️ Clear");
	await expect(passage("The storm breaks")).toContainText("Overridden");
	await expect(passage("Snow drifts")).toContainText("🌨️ Snow");
	await digested(llm, "The storm breaks");

	await passage("The storm breaks").hover();
	await passage("The storm breaks").getByRole("button", { name: "Reset" }).click();
	await expect(passage("The storm breaks")).not.toContainText("Overridden");
	await expect(passage("The storm breaks")).toContainText(/\+\d+h( \d+m)? · ⛈️ Storm/);
});

test("catch-up shows its progress and can be cancelled", async ({ page, request, llm }) => {
	await selectBoxDecisionModel(request, "world-clock");
	await llm.chat({ chunks: ["The storm breaks over the tower."] });
	await page.goto("/");
	await send(page, "Wait out the night.");
	await expect(story(page).locator("article").getByText("The storm breaks")).toBeVisible();
	await insertBox(page, "World Clock");
	const window = await openWorldClock(page);

	await llm.decisions(...digest(undefined, "none", "not mentioned", true));
	await window.getByRole("button", { name: "Digest missing passages" }).click();
	await expect(window.getByText(/^Digesting 0 of \d+…/)).toBeVisible();
	await window.getByRole("button", { name: "Cancel" }).click();
	await expect(window.getByRole("button", { name: "Digest missing passages" })).toBeVisible();
	await expect(window.getByRole("listitem").filter({ hasText: "The storm breaks" })).toContainText("Not read yet");
	await llm.release();
	// @approved
	//  A cancelled run never leaves a record: the passage is still missing, so
	//  a second catch-up runs and fills the automatic result.
	await window.getByRole("button", { name: "Digest missing passages" }).click();
	await expect(window.getByRole("listitem").filter({ hasText: "The storm breaks" })).toContainText("No time passes");
});

test("passage override drafts survive guarded close until saved or discarded", async ({ page, request }) => {
	await page.goto("/");
	const { activeChatId } = await (await request.get("/api/workspace")).json();
	await insertBox(page, "World Clock");
	let window = await openWorldClock(page);
	const passage = () => window.getByRole("listitem").filter({ hasText: "You arrive as she pins a third map over the first two." });
	await passage().hover();
	await passage().getByRole("button", { name: "Edit" }).click();
	await passage().getByRole("spinbutton", { name: "Minutes" }).fill("125");
	await passage().getByRole("combobox", { name: "Weather" }).click();
	await page.getByRole("option", { name: "☀️ Clear" }).click();

	await window.getByRole("button", { name: "Close World Clock" }).click();
	let unsaved = page.getByRole("dialog", { name: "Unsaved changes" });
	await expect(unsaved).toBeVisible();
	await unsaved.getByRole("button", { name: "Keep editing" }).click();
	await expect(passage().getByRole("spinbutton", { name: "Minutes" })).toHaveValue("125");
	await expect(passage().getByRole("combobox", { name: "Weather" })).toContainText("Clear");

	await window.getByRole("button", { name: "Close World Clock" }).click();
	unsaved = page.getByRole("dialog", { name: "Unsaved changes" });
	await unsaved.getByRole("button", { name: "Discard" }).click();
	await expect(window).toHaveCount(0);
	window = await openWorldClock(page);
	await passage().hover();
	await passage().getByRole("button", { name: "Edit" }).click();
	await expect(passage().getByRole("spinbutton", { name: "Minutes" })).toHaveValue("");
	await expect(passage().getByRole("combobox", { name: "Weather" })).toContainText("Not mentioned");
	await passage().getByRole("button", { name: "Cancel" }).click();

	await passage().hover();
	await passage().getByRole("button", { name: "Edit" }).click();
	await passage().getByRole("spinbutton", { name: "Minutes" }).fill("125");
	await passage().getByRole("combobox", { name: "Weather" }).click();
	await page.getByRole("option", { name: "☀️ Clear" }).click();
	await window.getByRole("button", { name: "Close World Clock" }).click();
	unsaved = page.getByRole("dialog", { name: "Unsaved changes" });
	await unsaved.getByRole("button", { name: "Save and leave" }).click();
	await expect(window).toHaveCount(0);
	const read = await (await request.get(`/api/conversations/${activeChatId}/boxes/world-clock`)).json();
	const override = read.passages.find((entry: { content: string }) => entry.content === "You arrive as she pins a third map over the first two.");
	expect(override.record).toMatchObject({ minutes: 125, weather: "clear" });
	expect(override.overridden).toBe(true);
});

test("selecting a Chat from an open panel guards a passage override draft", async ({ page }) => {
	await page.setViewportSize({ width: 1600, height: 1000 });
	await page.goto("/");
	await insertBox(page, "World Clock");
	await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Chats", exact: true }).click();
	const otherChat = page.getByRole("button", { name: /^The Lantern House/ });
	await expect(otherChat).toBeVisible();
	const window = await openWorldClock(page);
	const passage = window.getByRole("listitem").filter({ hasText: "You arrive as she pins a third map over the first two." });
	await passage.getByRole("button", { name: "Edit", exact: true }).click();
	await passage.getByRole("spinbutton", { name: "Minutes" }).fill("125");
	await otherChat.click();
	const unsaved = page.getByRole("dialog", { name: "Unsaved changes" });
	await expect(unsaved).toBeVisible();
	await unsaved.getByRole("button", { name: "Keep editing" }).click();
	await expect(passage.getByRole("spinbutton", { name: "Minutes" })).toHaveValue("125");
	await otherChat.click();
	await unsaved.getByRole("button", { name: "Discard", exact: true }).click();
	await expect(window).toHaveCount(0);
	await expect(story(page).getByRole("heading", { name: /^The Lantern House/ })).toBeVisible();
});
