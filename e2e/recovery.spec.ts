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
	// The second content event crosses the time deadline; later output stays after that checkpoint.
	await llm.checkpointClock(0, 0, 1_100);
	await llm.chat({ chunks: ["The tide turns against the pier.\n\n", "Gulls scatter from the rail.\n\n", "Then the"], hold: true });
	await page.goto("/");
	await send(page, "Wait.");
	await expect(story(page).getByText("Gulls scatter from the rail.")).toBeVisible();
	await llm.restart("crash");
	await page.reload();
	const reply = story(page).locator("article").last();
	await expect(reply.getByText("Gulls scatter from the rail.")).toBeVisible();
	await expect(reply.getByText("Then the", { exact: true })).toHaveCount(0);
	await expect(reply.getByRole("button", { name: "Continue as Theodora Kline" })).toBeVisible();
	expect(await chatCalls(llm)).toHaveLength(1);
});

test("a crash after several checkpoints keeps all of them in order", async ({ page, llm }) => {
	// The second and fourth content events each cross the deadline, so the reply is stored as two deltas.
	await llm.checkpointClock(0, 0, 1_100, 1_100, 1_100, 2_200);
	await llm.chat({ chunks: ["The tide turns against the pier.\n\n", "Gulls scatter from the rail.\n\n", "The harbor lights flicker.\n\n", "A bell rings twice.\n\n", "Then the"], hold: true });
	await page.goto("/");
	await send(page, "Wait.");
	await expect(story(page).getByText("A bell rings twice.")).toBeVisible();
	await llm.restart("crash");
	await page.reload();
	const reply = story(page).locator("article").last();
	for (const paragraph of ["The tide turns against the pier.", "Gulls scatter from the rail.", "The harbor lights flicker.", "A bell rings twice."]) {
		await expect(reply.getByText(paragraph)).toBeVisible();
	}
	await expect(reply.getByText("Then the", { exact: true })).toHaveCount(0);
	expect(await chatCalls(llm)).toHaveLength(1);
});

test("a crash before any checkpoint removes the provisional reply but keeps the sent message", async ({ page, llm }) => {
	await llm.checkpointClock(0);
	await llm.chat({ chunks: ["The tide turns against the pier.\n\n", "Then the"], hold: true });
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
		// The eighth content event crosses the one-second deadline, so the paragraphs before it are
		// the durable checkpoint and the ninth leaves an uncheckpointed fragment.
		await llm.checkpointClock(0, 0, 0, 0, 0, 0, 0, 0, 1_100);
		await llm.chat({ chunks: ["The tide ", "turns ", "against ", "the pier.\n\n", "Gulls ", "scatter ", "from ", "the rail.\n\n", "Then the"], hold: true });
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
