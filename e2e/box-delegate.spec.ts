import type { APIRequestContext } from "@playwright/test";
import { test, expect, insertBox, send, story } from "./fixtures";
import { isAuthoringModelCall, isChatModelCall } from "./protocol";

// A restart cuts the open change stream mid-response.
test.use({ allowedBrowserErrors: /ERR_INCOMPLETE_CHUNKED_ENCODING/ });

const createStagehand = async (request: APIRequestContext, url: string): Promise<number> => {
	const { revision } = await (await request.get("/api/connection-settings")).json();
	const created = await (await request.post("/api/connection-settings/commands", { data: { type: "create-profile", expectedRevision: revision, profile: {
		displayName: "Stagehand", apiFormat: "chat-completions", requestUrl: `${url}/__e2e/authoring/`, modelsUrl: `${url}/__e2e/authoring/models`,
		modelBackend: "automatic", adapter: "openai-compatible", outputTokenRepresentation: "automatic", systemPlacement: "strict", timeoutMs: 60_000, pinnedModels: ["e2e-stagehand"],
	} } })).json();
	const profileId: number = created.settings.profiles.find(({ displayName }: { displayName: string }) => displayName === "Stagehand").id;
	return profileId;
};

test("a request the story model writes in the Scene's tag runs its delegate; a failure shows in the window, and Retry lands the record there and in the next Prompt Plan", async ({ page, request, llm }) => {
	await llm.installBox("scene");
	await llm.restart("graceful");
	const profileId = await createStagehand(request, llm.url);
	const applied = await request.post("/api/boxes/scene/delegate-settings/commands", { data: { type: "apply", expectedRevision: 0, profileId, model: "e2e-stagehand" } });
	expect(applied.ok()).toBe(true);
	await llm.authoring({ text: "I would rather not." }, { tools: [{ name: "apply", arguments: { operations: [{ kind: "place", prop: "lantern" }] } }] }, { text: "Done." });
	await llm.chat({ chunks: ["Maren sets it down. <scene>put the lantern on the table</scene>"] }, { chunks: ["The lantern throws long shadows."] });

	await page.goto("/");
	await insertBox(page, "Scene");
	await page.getByRole("button", { name: "Scene", exact: true }).click();
	const frame = page.getByRole("dialog", { name: "Scene" }).frameLocator("iframe");
	await expect(frame.getByText("The stage is empty.")).toBeVisible();

	await send(page, "Light the hall.");
	await expect(story(page).getByRole("button", { name: "put the lantern on the table" })).toBeVisible();
	await expect(story(page)).not.toContainText("<scene>");
	const window = page.getByRole("dialog", { name: "Scene" });
	await expect(window.getByRole("alert")).toHaveText(/^The delegate failed on Message \d+: The delegate ended without calling apply\.Retry$/);
	await expect(frame.getByText("The stage is empty.")).toBeVisible();
	// @approved
	//  A retried run lands its record without a Conversation revision, so the
	// open window shows it only by following the database's changes.
	await window.getByRole("button", { name: "Retry" }).click();
	await expect(frame.getByRole("list", { name: "Props" }).getByRole("listitem")).toHaveText(["lantern"]);
	await expect(window.getByRole("alert")).toHaveCount(0);

	await send(page, "Look around.");
	await expect(story(page).getByText("The lantern throws long shadows.")).toBeVisible();
	const chats = (await llm.log()).calls.filter(isChatModelCall);
	expect(chats).toHaveLength(2);
	expect(chats[1]!.body.messages.map(({ content }) => content).join("\n")).toContain("On stage: lantern."); // @approved Two calls were just checked.
	expect(chats[1]!.body.messages.map(({ content }) => content).join("\n")).toContain("<scene>put the lantern on the table</scene>"); // @approved Two calls were just checked.
});

test("an off delegate explains how to configure it, and the default offers missed requests without running until asked", async ({ page, request, llm }) => {
	await llm.installBox("scene");
	await llm.restart("graceful");
	await createStagehand(request, llm.url);
	await llm.chat({ chunks: ["Maren waits. <scene>put the lantern on the table</scene>"] });
	await llm.authoring({ tools: [{ name: "apply", arguments: { operations: [{ kind: "place", prop: "lantern" }] } }] }, { text: "Done." });
	await page.goto("/");
	await insertBox(page, "Scene");
	await page.getByRole("button", { name: "Scene", exact: true }).click();
	const window = page.getByRole("dialog", { name: "Scene" });
	const frame = window.frameLocator("iframe");
	await expect(window.getByText("Scene's delegate is off. Scene requests are left as written.")).toBeVisible();
	await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Connections", exact: true }).click();
	await page.locator(".primary-panel").getByRole("button", { name: /^Stagehand/ }).click();
	await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Stagehand");
	await page.getByRole("button", { name: "Close Connections", exact: true }).click();
	await send(page, "Light the hall.");
	await expect(story(page).getByRole("button", { name: "put the lantern on the table" })).toBeVisible();
	await expect(frame.getByText("The stage is empty.")).toBeVisible();
	await window.getByRole("button", { name: "Choose delegate model" }).click();
	await expect(page.getByRole("button", { name: "Scene delegate model: Choose a model", exact: true })).toBeVisible();
	await page.locator(".primary-panel").getByRole("button", { name: "Connections", exact: true }).click();
	await page.getByRole("region", { name: "Default delegate", exact: true }).getByRole("button").click();
	await page.getByRole("button", { name: "Default delegate model: Choose a model", exact: true }).click();
	await page.getByRole("option", { name: "e2e-stagehand", exact: true }).click();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
	await page.locator(".primary-panel").getByRole("button", { name: "Connections", exact: true }).click();
	await expect(page.getByRole("region", { name: "Scene delegate", exact: true })).toContainText("Uses the default delegate model");
	await page.getByRole("button", { name: "Close Connections", exact: true }).click();
	await expect(window.getByText("1 request has not run.")).toBeVisible();
	expect((await llm.log()).calls.filter(isAuthoringModelCall)).toHaveLength(0);
	await expect(frame.getByText("The stage is empty.")).toBeVisible();
	await window.getByRole("button", { name: "Run missed requests" }).click();
	await expect(frame.getByRole("list", { name: "Props" }).getByRole("listitem")).toHaveText(["lantern"]);
	await expect(window.getByRole("button", { name: "Run missed requests" })).toHaveCount(0);
});
