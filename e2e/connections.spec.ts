import { test, expect, enableDecisionModels } from "./fixtures";

test("a new connection discovers models and passes a connection test with its saved key", async ({ page, llm }) => {
	await llm.models(["e2e-model"]);
	await llm.chat({ chunks: ["pong"] });
	await page.goto("/");
	await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Connections" }).click();
	await page.getByRole("button", { name: "Add chat connection" }).click();
	await page.getByRole("menuitem", { name: /OpenAI Compatible/ }).click();
	await page.getByRole("textbox", { name: "Name" }).fill("Local model");
	await page.getByRole("textbox", { name: "Request URL" }).fill("https://local.invalid/v1/");
	await page.getByRole("textbox", { name: "Models URL" }).fill("https://local.invalid/v1/models");
	await page.getByRole("textbox", { name: "API key" }).fill("sk-e2e-secret");
	await page.getByRole("button", { name: "Save" }).click();
	await expect(page.getByRole("textbox", { name: "API key" })).toHaveAttribute("placeholder", "Saved · type to replace");

	await page.getByRole("combobox", { name: "Default model" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Refresh" }).click();
	await page.getByRole("option", { name: "e2e-model" }).click();
	await page.getByRole("button", { name: "Test connection" }).click();
	await expect(page.getByText("Connection succeeded. The provider answered the test request.")).toBeVisible();

	const calls = (await llm.log()).calls;
	expect(calls.map(({ kind, url }) => [kind, url])).toEqual([
		["models", "https://local.invalid/v1/models"],
		["chat", "https://local.invalid/v1/chat/completions"],
	]);
	expect(calls.map(({ headers }) => headers.authorization)).toEqual(["Bearer sk-e2e-secret", "Bearer sk-e2e-secret"]);
	expect(calls[1].body.model).toBe("e2e-model");
});

test("OpenRouter Decisions refreshes its filtered catalog and tests a discovered model", async ({ page, llm }) => {
	await llm.models(["e2e-decision"]);
	await llm.decisions({ match: [], answer: { type: "noul", noul: 0.9 } });
	await page.goto("/");
	await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Connections" }).click();
	await page.getByRole("button", { name: "Add Decision Model connection" }).click();
	await page.getByRole("menuitem", { name: /OpenRouter Decisions/ }).click();
	await page.getByRole("textbox", { name: "API key" }).fill("sk-e2e-decision");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "API key" })).toHaveAttribute("placeholder", "Saved · type to replace");
	await page.getByRole("combobox", { name: "Default model" }).click();
	await page.getByRole("dialog").getByRole("button", { name: "Refresh" }).click();
	await page.getByRole("option", { name: "e2e-decision", exact: true }).click();
	await page.getByRole("button", { name: "Test connection" }).click();
	await expect(page.getByRole("status").filter({ hasText: "Connection succeeded" })).toBeVisible();
	const { calls } = await llm.log();
	expect(calls.map(({ kind, url }) => [kind, url])).toEqual([
		["models", "https://openrouter.ai/api/v1/models?output_modalities=decisions"],
		["decision", "https://openrouter.ai/api/v1/systemone"],
	]);
	expect(calls[1].body.model).toBe("e2e-decision");
});

test.describe("Semantic Trigger settings read failure", () => {
	test.use({ allowedBrowserErrors: /^Failed to load resource: the server responded with a status of 503/ });
	test("shows a Connection Settings error and retries without leaving the editor", async ({ page, request }) => {
		await enableDecisionModels(request);
		await page.goto("/");
		await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Connections" }).click();
		const openSettings = page.getByRole("button", { name: /typesafe\/jev-1.13.*Decision Model/ });
		await expect(openSettings).toBeVisible();
		await page.route("**/api/connection-settings", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "Connection Settings unavailable" }) }));
		await openSettings.click();
		await expect(page.getByRole("alert").filter({ hasText: /Connection Settings.*loaded/ })).toBeVisible();
		await page.unroute("**/api/connection-settings");
		await page.getByRole("button", { name: "Try again" }).click();
		const picker = page.getByRole("button", { name: /Semantic Trigger Decision Model: OpenRouter Decisions/ });
		await expect(picker).toBeVisible();
		await expect(page.getByRole("alert")).toHaveCount(0);
		await picker.click();
		await page.getByRole("option", { name: "cloudflare/clef-flash", exact: true }).click();
		await page.getByRole("button", { name: "Save", exact: true }).click();
		await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
		const saved = await (await request.get("/api/semantic-trigger-settings")).json();
		expect(saved.decisionModel).toBe("cloudflare/clef-flash");
	});
});
