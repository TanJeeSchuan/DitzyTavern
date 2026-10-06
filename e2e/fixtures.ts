import { test as base, expect, type APIRequestContext, type Page } from "@playwright/test";
import { startE2eServer, type E2eServer } from "./harness";

export { expect };

export const test = base.extend<{ llm: E2eServer; allowedBrowserErrors: RegExp | null }, { server: E2eServer }>({
	allowedBrowserErrors: [null, { option: true }],
	// oxlint-disable-next-line no-empty-pattern
	server: [async ({}, use) => {
		const server = await startE2eServer();
		await use(server);
		await server.stop();
	}, { scope: "worker" }],
	baseURL: async ({ server }, use) => use(server.url),
	llm: [async ({ server, page, allowedBrowserErrors }, use, testInfo) => {
		await server.reset();
		server.takeStderr();
		const problems: string[] = [];
		page.on("pageerror", (error) => problems.push(error.message));
		page.on("console", (message) => message.type() === "error" && problems.push(message.text()));
		await use(server);
		const log = await server.log();
		await testInfo.attach("model-calls.json", { body: JSON.stringify(log, null, 2), contentType: "application/json" });
		await testInfo.attach("server-stderr.txt", { body: server.takeStderr(), contentType: "text/plain" });
		expect(log.unscripted, "unscripted model calls").toEqual([]);
		expect(log.unsentPlans, "captured Prompt Plans that no provider request matches").toEqual([]);
		expect(problems.filter((problem) => !allowedBrowserErrors?.test(problem)), "browser errors").toEqual([]);
	}, { auto: true }],
});

export const story = (page: Page) => page.getByRole("main", { name: "Active Chat" });

export const send = async (page: Page, text: string) => {
	await page.getByRole("textbox", { name: "Message draft" }).fill(text);
	await page.getByRole("button", { name: "Generate Variant" }).click();
	await page.getByRole("button", { name: "Send exact plan" }).click();
};

export const enableJev = async (request: APIRequestContext) => {
	const { revision, jevModel } = await (await request.get("/api/typesafe-settings")).json();
	await request.post("/api/typesafe-settings/commands", { data: {
		type: "apply", expectedRevision: revision, jevModel, loreTriggerMode: "jev", loreTriggerThreshold: 0.5, credential: "e2e-typesafe-key",
	} });
};
