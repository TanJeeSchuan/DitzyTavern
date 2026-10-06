import { test, expect } from "./fixtures";

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
