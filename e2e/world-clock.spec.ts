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
