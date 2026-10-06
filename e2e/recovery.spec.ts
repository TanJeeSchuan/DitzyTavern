import { test, expect, send, story } from "./fixtures";

test.use({ allowedBrowserErrors: /net::ERR_|^Unable to load Conversation/ });

const chatCalls = async (llm: import("./harness").E2eServer) => (await llm.log()).calls.filter((call) => call.kind === "chat");

test("a graceful restart keeps the partial reply and never retries the provider", async ({ page, llm }) => {
	await llm.checkpointClock(0);
	await llm.chat({ chunks: ["The tide turns against the pier.\n\n", "The harbor lights flicker.\n\n", "Then the"], hold: true });
	await page.goto("/");
	await send(page, "Wait.");
	await expect(story(page).getByText("The tide turns against the pier.")).toBeVisible();
	await expect(story(page).getByText("The harbor lights flicker.")).toBeVisible();
	await llm.restart("graceful");
	await page.reload();
	const reply = story(page).locator("article").last();
	await expect(reply.getByText("Then the")).toBeVisible();
	await expect(reply.getByRole("button", { name: "Continue as Theodora Kline" })).toBeVisible();
	expect(await chatCalls(llm)).toHaveLength(1);
});

test("a crash keeps the last checkpoint and never retries the provider", async ({ page, llm }) => {
	await llm.chat({ chunks: ["The tide turns against the pier.\n\n", "Gulls scatter from the rail.\n\n", "Then the"], chunkDelayMs: 1_100, hold: true });
	await page.goto("/");
	await send(page, "Wait.");
	await expect(story(page).getByText("Gulls scatter from the rail.")).toBeVisible();
	await llm.restart("crash");
	await page.reload();
	const reply = story(page).locator("article").last();
	await expect(reply.getByText("Gulls scatter from the rail.")).toBeVisible();
	await expect(reply.getByRole("button", { name: "Continue as Theodora Kline" })).toBeVisible();
	expect(await chatCalls(llm)).toHaveLength(1);
});

test("a crash before any checkpoint removes the provisional reply but keeps the sent message", async ({ page, llm }) => {
	await llm.checkpointClock(0);
	await llm.chat({ chunks: ["The tide turns against the pier.\n\n", "Then the"], firstChunkDelayMs: 1_100, hold: true });
	await page.goto("/");
	await send(page, "Wait.");
	await expect(story(page).getByText("The tide turns against the pier.")).toBeVisible();
	await llm.restart("crash");
	await page.reload();
	const sent = story(page).locator("article").last();
	await expect(sent.getByText("Wait.")).toBeVisible();
	await expect(sent.getByRole("button", { name: "Regenerate response" })).toBeVisible();
	await expect(story(page).getByText("The tide turns against the pier.")).toHaveCount(0);
	expect(await chatCalls(llm)).toHaveLength(1);
});

for (const mode of ["graceful", "crash"] as const) {
	test(`an open page settles an interrupted Generation once the server is back after ${mode} restart`, async ({ page, llm }) => {
		await llm.chat({ chunks: ["The tide turns against the pier.\n\n", "Gulls scatter from the rail.\n\n", "Then the"], chunkDelayMs: 1_100, hold: true });
		await page.goto("/");
		await send(page, "Wait.");
		await expect(story(page).getByText("Gulls scatter from the rail.")).toBeVisible();
		await llm.restart(mode);
		await expect(page.getByRole("button", { name: "Generate Variant" })).toBeVisible({ timeout: 15_000 });
		await expect(page.getByRole("button", { name: "Stop Generation" })).toHaveCount(0);
		await expect(page.getByText("Theodora Kline is writing")).toHaveCount(0);
		await expect(page.getByRole("textbox", { name: "Message draft" })).toBeEnabled();
		await page.getByRole("textbox", { name: "Message draft" }).fill("Continue.");
		await expect(story(page).getByText("Gulls scatter from the rail.")).toBeVisible();
		expect(await chatCalls(llm)).toHaveLength(1);
	});
}
