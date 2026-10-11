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

/** @approved A new Chat holds only the Author Note and Memory; a spec inserts any other Box through the Box manager. */
export const insertBox = async (page: Page, title: string) => {
	await page.getByRole("button", { name: "Boxes", exact: true }).click();
	const toggle = page.getByRole("switch", { name: `${title} in this Chat` });
	await toggle.click();
	await expect(toggle).toBeChecked();
	await page.keyboard.press("Escape");
};

export const send = async (page: Page, text: string) => {
	const composer = page.getByRole("textbox", { name: "Message draft" });
	await expect(composer).toHaveAttribute("contenteditable", "true");
	await composer.fill(text);
	await page.getByRole("button", { name: "Generate Variant" }).click();
	await page.getByRole("button", { name: "Send exact plan" }).click();
};

const createDecisionProfile = async (request: APIRequestContext) => {
	const { revision: connectionRevision } = await (await request.get("/api/connection-settings")).json();
	const { presets } = await (await request.get("/api/connection-settings/presets")).json();
	const profile = presets.find((preset: { id: string }) => preset.id === "openrouter-decisions").profile;
	const created = await (await request.post("/api/connection-settings/commands", { data: { type: "create-profile", expectedRevision: connectionRevision, profile, credential: "e2e-decision-key" } })).json();
	const decisionProfileId = created.settings.profiles.find((entry: { displayName: string }) => entry.displayName === profile.displayName).id;
	return { decisionProfileId, decisionModel: "typesafe/jev-1.13", decisionStateTokenLimit: 16000 };
};

export const enableWorldClock = async (request: APIRequestContext) => {
	const selection = await createDecisionProfile(request);
	const { revision } = await (await request.get("/api/boxes/world-clock/decision-settings")).json();
	await request.post("/api/boxes/world-clock/decision-settings/commands", { data: { type: "apply", expectedRevision: revision, ...selection } });
};

export const enableDecisionModels = async (request: APIRequestContext) => {
	const selection = await createDecisionProfile(request);
	const { revision: semanticRevision } = await (await request.get("/api/semantic-trigger-settings")).json();
	await request.post("/api/semantic-trigger-settings/commands", { data: { type: "apply", expectedRevision: semanticRevision, ...selection, triggerThreshold: 0.5 } });
	const { revision, ...settings } = await (await request.get("/api/memory-settings")).json();
	await request.post("/api/memory-settings/commands", { data: { ...settings, expectedRevision: revision, ...selection } });
};
