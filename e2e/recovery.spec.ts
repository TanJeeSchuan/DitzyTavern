import { test, expect, send, story } from "./fixtures";

test.use({ allowedBrowserErrors: /net::ERR_|^Unable to load Conversation/ });

const chatCalls = async (llm: import("./harness").E2eServer) => (await llm.log()).calls.filter((call) => call.kind === "chat");

test("a graceful restart keeps the partial reply and never retries the provider", async ({ page, llm }) => {
	await llm.chat({ chunks: ["The tide turns against the pier.\n\n", "Then the"], hold: true });
	await page.goto("/");
	await send(page, "Wait.");
	await expect(story(page).getByText("The tide turns against the pier.")).toBeVisible();
	await llm.restart("SIGHUP");
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
	await llm.restart("SIGKILL");
	await page.reload();
	const reply = story(page).locator("article").last();
	await expect(reply.getByText("Gulls scatter from the rail.")).toBeVisible();
	await expect(reply.getByRole("button", { name: "Continue as Theodora Kline" })).toBeVisible();
	expect(await chatCalls(llm)).toHaveLength(1);
});

test("a crash before any checkpoint removes the provisional reply but keeps the sent message", async ({ page, llm }) => {
	await llm.chat({ chunks: ["The tide turns against the pier.\n\n", "Then the"], hold: true });
	await page.goto("/");
	await send(page, "Wait.");
	await expect(story(page).getByText("The tide turns against the pier.")).toBeVisible();
	await llm.restart("SIGKILL");
	await page.reload();
	const sent = story(page).locator("article").last();
	await expect(sent.getByText("Wait.")).toBeVisible();
	await expect(sent.getByRole("button", { name: "Regenerate response" })).toBeVisible();
	await expect(story(page).getByText("The tide turns against the pier.")).toHaveCount(0);
	expect(await chatCalls(llm)).toHaveLength(1);
});

test("an open page settles an interrupted Generation once the server is back", async ({ page, llm }) => {
	test.fail(true, "Known bug: the detached session's single refresh fails while the server is down and is never retried.");
	await llm.chat({ chunks: ["The tide turns against the pier.\n\n", "Then the"], hold: true });
	await page.goto("/");
	await send(page, "Wait.");
	await expect(story(page).getByText("The tide turns against the pier.")).toBeVisible();
	await llm.restart("SIGHUP");
	await expect(page.getByRole("button", { name: "Generate Variant" })).toBeVisible({ timeout: 15_000 });
	await expect(story(page).getByText("Then the")).toBeVisible();
});
