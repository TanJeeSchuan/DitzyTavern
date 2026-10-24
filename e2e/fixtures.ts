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

export const openBoxes = async (page: Page) => {
	await expect(story(page)).toBeVisible({ timeout: 15_000 });
	const boxes = page.getByRole("group", { name: "Boxes", exact: true });
	if (await page.locator(".box-manager").isVisible()) {
		// Waiting for a row also waits out a dialog that closed a moment ago, which can leave the panel hidden.
		await expect(boxes.getByRole("listitem").first()).toBeVisible();
		return boxes;
	}
	const navigation = page.getByRole("button", { name: "Open navigation", exact: true });
	if (await navigation.isVisible()) await navigation.click();
	await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Boxes", exact: true }).click();
	return boxes;
};

export const closeBoxes = async (page: Page) => {
	await page.locator(".primary-panel").getByRole("button", { name: /^(Close Boxes|Back to Chat)$/ }).filter({ visible: true }).click();
};

/** A new Chat holds only the Author Note and Memory; a spec inserts any other Box through the Box manager, which adds an absent Box and turns a disabled one back on. */
export const insertBox = async (page: Page, title: string) => {
	const boxes = await openBoxes(page);
	const add = boxes.getByRole("button", { name: `Add ${title}`, exact: true });
	if (await add.count() > 0) await add.click();
	else await boxes.getByRole("switch", { name: `${title} in this Chat` }).click();
	await expect(boxes.getByRole("switch", { name: `${title} in this Chat` })).toBeChecked();
	await closeBoxes(page);
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

const applyBoxDecision = async (request: APIRequestContext, box: string, selection: Awaited<ReturnType<typeof createDecisionProfile>>) => {
	const { revision } = await (await request.get(`/api/boxes/${box}/decision-settings`)).json();
	await request.post(`/api/boxes/${box}/decision-settings/commands`, { data: { type: "apply", expectedRevision: revision, ...selection } });
};

/** @approved Gives a digesting Box a Decision Model selection, so its digests run against the scripted `/systemone`. */
export const selectBoxDecisionModel = async (request: APIRequestContext, box: string) => applyBoxDecision(request, box, await createDecisionProfile(request));

/** @approved Gives Semantic Triggers and Memory one Decision Model selection. */
export const enableDecisionModels = async (request: APIRequestContext) => {
	const selection = await createDecisionProfile(request);
	const { revision } = await (await request.get("/api/semantic-trigger-settings")).json();
	await request.post("/api/semantic-trigger-settings/commands", { data: { type: "apply", expectedRevision: revision, ...selection, triggerThreshold: 0.5 } });
	await applyBoxDecision(request, "memory", selection);
};
