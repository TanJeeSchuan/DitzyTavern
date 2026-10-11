import type { Page } from "@playwright/test";
import { test, expect, enableWorldClock, story } from "./fixtures";
import type { E2eServer } from "./harness";

const elapsed = ["none", "~5m", "~15m", "~30m", "~1h", "~2h", "~4h", "~8h", "overnight", "~1 day", "several days"];
const weather = ["not mentioned", "clear", "cloudy", "rain", "storm", "snow", "fog"];
const choice = (selected: string, labels: string[]) => ({
	type: "choice" as const, choice: selected,
	probabilities: Object.fromEntries(labels.map((label) => [label, label === selected ? 0.9 : 0.1 / (labels.length - 1)])),
});
const digest = (passage: string | undefined, bin: string, established: string) => [
	{ passage, match: ["How much in-world time passes"], answer: choice(bin, elapsed) },
	{ passage, match: ["What weather does"], answer: choice(established, weather) },
];

const digested = (llm: E2eServer, passage: string) => expect.poll(async () => (await llm.log()).calls
	.some((call) => call.kind === "decision" && JSON.stringify(call.body.state.passage).includes(passage))).toBe(true);

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
	const window = await openWorldClock(page);
	await window.getByRole("switch", { name: "Turn on the World Clock" }).click();
	await window.getByRole("button", { name: "Save World Clock" }).click();
	await expect(window.getByRole("button", { name: "Save World Clock" })).toBeDisabled();
	await window.getByRole("button", { name: "Minimize World Clock" }).click();
};

const dockTab = (page: Page) => page.getByRole("button", { name: /^World Clock: / });

test("the World Clock digests passages in the background and follows the selected Variant", async ({ page, request, llm }) => {
	await enableWorldClock(request);
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
	await expect(story(page).getByText("The storm breaks")).toBeVisible();
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
	await expect(story(page).getByText("She lights the lamp.")).toBeVisible();
	await digested(llm, "She lights the lamp.");

	await reply.hover();
	await reply.getByRole("button", { name: "Previous Swipe" }).click();
	await page.getByRole("status", { name: "Swipe preview" }).getByRole("button", { name: "Confirm" }).click();
	await expect(reply.getByText("The storm breaks")).toBeVisible();
	await expect(await sendWithClock(page, "And now?")).toHaveText(/^\d+:\d\d PM \| 🗓️ Sunday, June 1, 2025 AD \| ⛈️ Storm, -?\d+°C$/);
	await send.click();
	await expect(story(page).getByText("She keeps watch.")).toBeVisible();
	await digested(llm, "She keeps watch.");
});

test("the dock status updates when a digest lands without reopening the window", async ({ page, request, llm }) => {
	await enableWorldClock(request);
	await llm.decisions(
		...digest("Wait out the night.", "overnight", "clear"),
		...digest("Dawn comes", "~1h", "clear"),
	);
	await llm.chat({ chunks: ["Dawn comes over the water."] });
	await page.goto("/");
	await enableClock(page);
	await expect(dockTab(page)).toHaveText("World Clock: 8:00 AM");

	await sendWithClock(page, "Wait out the night.");
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(story(page).getByText("Dawn comes")).toBeVisible();
	await digested(llm, "Wait out the night.");
	await digested(llm, "Dawn comes");

	await expect(dockTab(page)).toHaveText(/^World Clock: \d{1,2}:\d\d PM( · .+)?$/, { timeout: 15_000 });
});

test("a clock that is off contributes no clock line and queues no digest", async ({ page, request, llm }) => {
	await enableWorldClock(request);
	await llm.chat({ chunks: ["The lamp turns above you."] });
	await page.goto("/");
	const composer = page.getByRole("textbox", { name: "Message draft" });
	await expect(composer).toHaveAttribute("contenteditable", "true");
	await composer.fill("Look outside.");
	await page.getByRole("button", { name: "Generate Variant" }).click();
	const preview = page.getByRole("complementary", { name: "Prompt Plan preview" });
	await expect(preview.getByText(/^World Clock ·/)).toHaveCount(0);
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(story(page).getByText("The lamp turns above you.")).toBeVisible();
	expect((await llm.log()).calls.some((call) => call.kind === "decision")).toBe(false);
});

test("window layout and setup stay with their Chat", async ({ page }) => {
	await page.goto("/");
	await enableClock(page);
	await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Chats", exact: true }).click();
	await page.getByRole("button", { name: /^The Lantern House/ }).click();
	await expect(dockTab(page)).toHaveCount(0);
	const window = await openWorldClock(page);
	await expect(window.getByRole("switch", { name: "Turn on the World Clock" })).toBeVisible();
});
