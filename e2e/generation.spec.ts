import { test, expect, send, story } from "./fixtures";

test("a sent message streams the scripted reply and survives a reload", async ({ page, llm }) => {
	await llm.chat({ chunks: ["The lamp ", "flickers twice."] });
	await page.goto("/");
	await send(page, "I climb the stairs.");
	await expect(story(page).getByText("The lamp flickers twice.")).toBeVisible();
	await page.reload();
	await expect(story(page).getByText("I climb the stairs.")).toBeVisible();
	await expect(story(page).getByText("The lamp flickers twice.")).toBeVisible();
	const [call] = (await llm.log()).calls.filter((entry) => entry.kind === "chat");
	expect(JSON.stringify(call.body.messages)).toContain("I climb the stairs.");
});

test("stopping mid-stream keeps the partial reply", async ({ page, llm }) => {
	await llm.chat({ chunks: ["The tide turns against the pier.\n\n", "Then the"], hold: true });
	await page.goto("/");
	await send(page, "Wait.");
	await expect(story(page).getByText("The tide turns against the pier.")).toBeVisible();
	await page.getByLabel("Stop Generation").click();
	await expect(page.getByRole("button", { name: "Generate Variant" })).toBeVisible();
	await page.reload();
	await expect(story(page).getByText("The tide turns against the pier.")).toBeVisible();
});

test("a new swipe generates an alternative next to the original", async ({ page, llm }) => {
	await llm.chat({ chunks: ["First take."] }, { chunks: ["Second take."] });
	await page.goto("/");
	await send(page, "Again.");
	const reply = story(page).locator("article").last();
	await expect(reply.getByText("First take.")).toBeVisible();
	await reply.getByRole("button", { name: "New Swipe" }).click();
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(reply.getByText("Second take.")).toBeVisible();
	await expect(reply.getByText("2 of 2")).toBeVisible();
	await reply.getByRole("button", { name: "Previous Swipe" }).click();
	await expect(reply.getByText("First take.")).toBeVisible();
});

test("a provider error is reported", async ({ page, llm }) => {
	await llm.chat({ status: 503, error: "The upstream model is overloaded.", hold: true });
	await page.goto("/");
	await send(page, "Hello?");
	await expect(story(page).getByRole("status", { name: "Theodora Kline is writing" })).toBeVisible();
	await llm.release();
	await expect(page.getByText("The provider request failed with HTTP 503.", { exact: true })).toBeVisible();
});

test("a provider error that fails before the client subscribes is still reported", async ({ page, llm }) => {
	await llm.chat({ status: 401, error: "Invalid API key." });
	await page.route("**/api/conversations/*/generations", async (route) => {
		const response = await route.fetch();
		const { generationId } = await response.json();
		const terminal = await page.request.get(`${route.request().url()}/${generationId}/events`);
		expect(await terminal.text()).toContain('"reason":"The provider request failed with HTTP 401."');
		await route.fulfill({ response });
	});
	await page.goto("/");
	await send(page, "Hello?");
	const failure = page.getByText("The provider request failed with HTTP 401.", { exact: true });
	await expect(failure).toBeVisible();
	await expect(failure).toHaveCount(1);
	await expect(story(page).getByText("Hello?", { exact: true })).toBeVisible();
	await page.getByRole("textbox", { name: "Message draft" }).fill("Still here.");
	await expect(page.getByRole("button", { name: "Generate Variant" })).toBeEnabled();
	await page.getByRole("button", { name: "Dismiss generation error" }).click();
	await page.reload();
	await expect(story(page).getByText("Hello?", { exact: true })).toBeVisible();
	await expect(failure).toHaveCount(0);
});

for (const outcome of ["applied", "stopped"] as const) {
	test(`a Generation already ${outcome} before acceptance settles without a failure toast`, async ({ page, llm }) => {
		await llm.chat({ chunks: ["A quiet answer."], hold: outcome === "stopped" });
		await page.route("**/api/conversations/*/generations", async (route) => {
			const response = await route.fetch();
			const { generationId } = await response.json();
			const generationUrl = `${route.request().url()}/${generationId}`;
			if (outcome === "stopped") {
				await expect.poll(async () => (await llm.log()).calls.length).toBe(1);
				expect((await page.request.post(`${generationUrl}/stop`, { data: {} })).ok()).toBe(true);
			}
			const terminal = await page.request.get(`${generationUrl}/events`);
			expect(await terminal.text()).toContain(`"outcome":"${outcome}"`);
			await route.fulfill({ response });
		});
		await page.goto("/");
		await send(page, "A quick question.");
		await expect(story(page).getByText("A quick question.", { exact: true })).toBeVisible();
		if (outcome === "applied") await expect(story(page).getByText("A quiet answer.", { exact: true })).toBeVisible();
		const composer = page.getByRole("textbox", { name: "Message draft" });
		await expect(composer).toHaveAttribute("contenteditable", "true");
		await composer.fill("Next question.");
		await expect(page.getByRole("button", { name: "Generate Variant" })).toBeEnabled();
		await expect(page.getByText("Generation failed", { exact: true })).toHaveCount(0);
	});
}

test("an edited Prompt Plan is sent exactly as edited", async ({ page, llm }) => {
	await llm.chat({ chunks: ["Edited reply."] });
	await page.goto("/");
	await page.getByRole("textbox", { name: "Message draft" }).fill("Original guidance.");
	await page.getByRole("button", { name: "Generate Variant" }).click();
	const preview = page.getByRole("complementary", { name: "Prompt Plan preview" });
	await preview.getByText(/^History ·/).click();
	await preview.getByRole("textbox").filter({ hasText: "Original guidance." }).fill("Rewritten guidance.");
	await preview.getByRole("button", { name: "Send exact plan" }).click();
	await expect(story(page).getByText("Edited reply.")).toBeVisible();
	const [call] = (await llm.log()).calls.filter((entry) => entry.kind === "chat");
	expect(JSON.stringify(call.body.messages)).toContain("Rewritten guidance.");
	expect(JSON.stringify(call.body.messages)).not.toContain("Original guidance.");
});
