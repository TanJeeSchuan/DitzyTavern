import type { APIRequestContext } from "@playwright/test";
import { test, expect, enableDecisionModels, send, story } from "../../../e2e/fixtures";
import type { DecisionRule } from "../../../e2e/protocol";

const blank = { systemInstruction: "", identity: "", appearance: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };

/** @approved The default delegate model, which a Box without its own runs its code agent on, pointed at the scripted authoring fake. */
const chooseAgentModel = async (request: APIRequestContext, url: string) => {
	const { revision } = await (await request.get("/api/connection-settings")).json();
	const created = await (await request.post("/api/connection-settings/commands", { data: { type: "create-profile", expectedRevision: revision, profile: {
		displayName: "Stagehand", apiFormat: "chat-completions", requestUrl: `${url}/__e2e/authoring/`, modelsUrl: `${url}/__e2e/authoring/models`,
		modelBackend: "automatic", adapter: "openai-compatible", outputTokenRepresentation: "automatic", systemPlacement: "strict", timeoutMs: 60_000, pinnedModels: ["e2e-stagehand"],
	} } })).json();
	const profileId: number = created.settings.profiles.find(({ displayName }: { displayName: string }) => displayName === "Stagehand").id;
	const settings = "/api/boxes/$default/delegate-settings";
	const { revision: delegateRevision } = await (await request.get(settings)).json();
	expect((await request.post(`${settings}/commands`, { data: { type: "apply", expectedRevision: delegateRevision, profileId, model: "e2e-stagehand" } })).ok()).toBe(true);
};

const choice = (selected: string, labels: string[]) => ({
	type: "choice" as const, choice: selected, confidence: 0.9,
	probabilities: Object.fromEntries(labels.map((label) => [label, label === selected ? 0.9 : 0.1 / (labels.length - 1)])),
});
const keep = (claim: string): DecisionRule[] => [
	{ match: [claim, "How does `source` relate to `memory.claim`?"], answer: choice("supported", ["supported", "contradicted", "not_established"]) },
	{ match: [claim, "is `memory.attribution` the one who"], answer: choice("correct", ["correct", "misattributed", "unclear"]) },
	{ match: [claim, "still matter to the story"], answer: choice("retain", ["retain", "omit"]) },
];

test("a person Memory knows is drafted from the window and added to the Cast only when the writer chooses", async ({ page, request, llm }) => {
	await enableDecisionModels(request);
	await llm.memories({ claim: "Old Pell keeps the observatory's spare keys.", attribution: "Theodora Kline", people: ["Old Pell"], excerpt: "Pell keeps the spare keys." });
	await llm.decisions(...keep("spare keys"));
	await llm.chat({ chunks: ["Old Pell shuffles in. \"Dome's humming again,\" he mutters. Theodora sighs. \"Pell keeps the spare keys.\""] });
	const { profiles } = await (await request.get("/api/connection-settings")).json();
	const { revision: memoryRevision, ...memory } = await (await request.get("/api/boxes/memory/settings")).json();
	await request.post("/api/boxes/memory/settings/commands", { data: {
		...memory, expectedRevision: memoryRevision,
		extractionProfileId: profiles.find(({ apiFormat }: { apiFormat: string }) => apiFormat === "chat-completions").id, extractionModel: "e2e-model",
	} });
	await chooseAgentModel(request, llm.url);
	const { activeChatId } = await (await request.get("/api/workspace")).json();
	const url = `/api/conversations/${activeChatId}`;

	await page.goto("/");
	await send(page, "Who just came in?");
	await expect(story(page).getByText("Old Pell shuffles in.")).toBeVisible();
	await expect.poll(async () => (await (await request.get(`/api/boxes/character-drafter/conversations/${activeChatId}`)).json()).people, { timeout: 15_000 }).toEqual(["Old Pell"]);
	const reply = (await (await request.get(`${url}/history`)).json()).messages.at(-1).id;
	await llm.authoring(
		{ tools: [{ name: "run", arguments: { code: "memory.claims[\"Old Pell\"].map((found) => found.claim)" } }] },
		{ tools: [{ name: "submit", arguments: { draft: {
			name: "Old Pell",
			prompt: { ...blank, identity: "Old Pell is the observatory's night porter.\n\nReputation: Theodora says he keeps the spare keys.", exampleDialogue: "\"Dome's humming again,\"" },
			quotes: [{ messageId: reply, text: "\"Dome's humming again,\"" }],
		} } }] },
	);

	await page.getByRole("button", { name: "Character Drafter", exact: true }).click();
	const window = page.getByRole("dialog", { name: "Character Drafter" });
	await window.getByRole("group", { name: "People Memory knows" }).getByRole("button", { name: "Old Pell", exact: true }).click();
	await expect(window.getByRole("textbox", { name: "Person" })).toHaveValue("Old Pell");
	await window.getByRole("button", { name: "Draft", exact: true }).click();
	await expect(window.getByText("Drafted Old Pell.")).toBeVisible();
	await window.getByRole("list", { name: "Agent steps" }).getByText("memory.claims", { exact: false }).click();
	await expect(window.getByRole("textbox", { name: "Step 1 output" })).toContainText("Old Pell keeps the observatory's spare keys.");
	expect((await (await request.get(url)).json()).cast.map(({ name }: { name: string }) => name)).not.toContain("Old Pell");

	await page.getByRole("button", { name: "Characters", exact: true }).click();
	await page.getByRole("button", { name: /Theodora Kline maps coastlines/ }).first().click();
	const name = page.getByRole("textbox", { name: "Name", exact: true });
	await name.fill("Theodora with unsaved edits");
	const unsaved = page.getByRole("dialog", { name: "Unsaved changes" });
	await window.getByRole("button", { name: "Open draft", exact: true }).click();
	await unsaved.getByRole("button", { name: "Keep editing" }).click();
	await expect(name).toHaveValue("Theodora with unsaved edits");
	await expect(window.getByText("Drafted Old Pell.")).toBeVisible();

	await window.getByRole("button", { name: "Open draft", exact: true }).click();
	await unsaved.getByRole("button", { name: "Discard" }).click();
	await expect(name).toHaveValue("Old Pell");
	// A draft is handed to the editor once, so it cannot be kept twice.
	await expect(window.getByText("Opened the draft of Old Pell in the Characters panel.")).toBeVisible();
	await expect(window.getByRole("button", { name: "Open draft", exact: true })).toHaveCount(0);
	await expect(page.getByRole("textbox", { name: "Identity" })).toContainText("Reputation: Theodora says he keeps the spare keys.");
	const releaseSave = Promise.withResolvers<void>();
	await page.route(`**${url}/commands`, async (route) => {
		await releaseSave.promise;
		await route.continue();
	}, { times: 1 });
	try {
		await page.getByRole("button", { name: "Add to Cast", exact: true }).click();
		await expect(page.getByText("Saving…", { exact: true })).toBeVisible();
		const nameField = page.locator('input[aria-label="Name"]');
		await nameField.evaluate((input) => input.focus());
		await expect(nameField).not.toBeFocused();
	} finally { releaseSave.resolve(); }
	await expect(page.getByText("Chat only · Changes stay in this Chat")).toBeVisible();
	await page.locator(".primary-panel").getByRole("button", { name: "Characters", exact: true }).click();
	await expect(page.getByRole("region", { name: "In this chat" })).toContainText("Old Pell");
	expect((await (await request.get(url)).json()).cast.find(({ name }: { name: string }) => name === "Old Pell").prompt.exampleDialogue).toBe("\"Dome's humming again,\"");
});

test("both Drafter entry points wait for a successful model availability read", async ({ page }) => {
	const releaseRead = Promise.withResolvers<void>();
	await page.route("**/api/boxes/character-drafter/conversations/*", async (route) => {
		await releaseRead.promise;
		await route.fulfill({ json: { unexpected: true } });
	});
	await page.goto("/");
	await page.getByRole("button", { name: "Characters", exact: true }).click();
	await page.getByRole("button", { name: /Theodora Kline maps coastlines/ }).first().click();
	const participant = page.getByRole("region", { name: "Character Drafter" });
	await page.getByRole("button", { name: "Character Drafter", exact: true }).click();
	const window = page.getByRole("dialog", { name: "Character Drafter" });
	try {
		await window.getByRole("textbox", { name: "Person" }).fill("Old Pell");
		await expect(window.getByRole("button", { name: "Draft", exact: true })).toBeDisabled();
		await expect(participant.getByRole("button", { name: "Draft from story" })).toBeDisabled();
	} finally { releaseRead.resolve(); }
	for (const entry of [window, participant]) {
		await expect(entry.getByText("Couldn't check the agent model.", { exact: false })).toBeVisible();
	}
	await expect(window.getByRole("button", { name: "Draft", exact: true })).toBeDisabled();
	await expect(participant.getByRole("button", { name: "Draft from story" })).toBeDisabled();
});

test("a Cast member drafted from their Participant editor replaces their Definition after a confirmation and keeps their Portrait and Openings", async ({ page, request, llm }) => {
	await chooseAgentModel(request, llm.url);
	const { activeChatId } = await (await request.get("/api/workspace")).json();
	const url = `/api/conversations/${activeChatId}`;
	const before = await (await request.get(url)).json();
	const theodora = before.cast.find(({ name }: { name: string }) => name === "Theodora Kline");
	const portrait = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1EAAAAASUVORK5CYII=", "base64");
	const { hash } = await (await request.post("/api/images", { data: { data: portrait.toString("base64") } })).json();
	const { prompt, openings, sendAppearanceImages } = theodora;
	expect((await request.post(`${url}/commands`, { data: { expectedRevision: before.revision, action: {
		type: "update-participant-definition", participantId: theodora.id, definition: { name: theodora.name, prompt, sendAppearanceImages, openings, portrait: { hash, focalX: 0.5, focalY: 0.5 } },
	} } })).ok()).toBe(true);
	await llm.authoring({ tools: [{ name: "submit", arguments: { draft: { name: "Dr. Theodora Kline", prompt: { ...blank, identity: "She runs the night shift now." }, quotes: [] } } }] });

	await page.goto("/");
	await page.getByRole("button", { name: "Characters" }).click();
	// The Cast row button precedes its row menu, so first() opens the editor.
	await page.getByRole("button", { name: /Theodora Kline maps coastlines/ }).first().click();
	await page.getByRole("region", { name: "Character Drafter" }).getByRole("button", { name: "Draft from story", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Dr. Theodora Kline");
	await page.getByRole("button", { name: "Replace Theodora Kline's Definition", exact: true }).click();
	const confirm = page.getByRole("dialog", { name: "Replace Theodora Kline's Definition?" });
	await confirm.getByRole("button", { name: "Replace", exact: true }).click();
	await expect(page.getByText("Changes stay in this Chat", { exact: false })).toBeVisible();
	await expect(page.getByRole("button", { name: "Edit the Portrait" })).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Dr. Theodora Kline");

	const replaced = (await (await request.get(url)).json()).cast.find(({ id }: { id: number }) => id === theodora.id);
	expect(replaced.name).toBe("Dr. Theodora Kline");
	expect(replaced.prompt.identity).toBe("She runs the night shift now.");
	expect(replaced.portrait.hash).toBe(hash);
	expect(replaced.openings).toEqual(openings);
});

test.describe("a Replace sent after the Participant changed elsewhere", () => {
	test.use({ allowedBrowserErrors: /status of 409/ });

	test("conflicts instead of reverting the newer Openings, and replaces once the writer loads them", async ({ page, request, llm }) => {
		await chooseAgentModel(request, llm.url);
		const { activeChatId } = await (await request.get("/api/workspace")).json();
		const url = `/api/conversations/${activeChatId}`;
		await llm.authoring({ tools: [{ name: "submit", arguments: { draft: { name: "Dr. Theodora Kline", prompt: { ...blank, identity: "She runs the night shift now." }, quotes: [] } } }] });
		await page.goto("/");
		await page.getByRole("button", { name: "Characters" }).click();
		// The Cast row button precedes its row menu, so first() opens the editor.
		await page.getByRole("button", { name: /Theodora Kline maps coastlines/ }).first().click();
		await page.getByRole("region", { name: "Character Drafter" }).getByRole("button", { name: "Draft from story", exact: true }).click();
		await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Dr. Theodora Kline");

		const opened = await (await request.get(url)).json();
		const theodora = opened.cast.find(({ name }: { name: string }) => name === "Theodora Kline");
		const openings = [...theodora.openings, "The dome creaks open."];
		expect((await request.post(`${url}/commands`, { data: { expectedRevision: opened.revision, action: {
			type: "update-participant-definition", participantId: theodora.id, definition: { name: theodora.name, prompt: theodora.prompt, sendAppearanceImages: theodora.sendAppearanceImages, openings },
		} } })).ok()).toBe(true);
		const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === url);
		await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
		await refreshed;

		const replace = async () => {
			await page.getByRole("button", { name: "Replace Theodora Kline's Definition", exact: true }).click();
			await page.getByRole("dialog", { name: "Replace Theodora Kline's Definition?" }).getByRole("button", { name: "Replace", exact: true }).click();
		};
		await replace();
		await expect(page.getByText("Theodora Kline changed elsewhere after this draft opened, so nothing was replaced.", { exact: false })).toBeVisible();
		const kept = (await (await request.get(url)).json()).cast.find(({ id }: { id: number }) => id === theodora.id);
		expect(kept.name).toBe("Theodora Kline");
		expect(kept.openings).toEqual(openings);

		await page.getByRole("button", { name: "Load saved version", exact: true }).click();
		await expect(page.getByRole("textbox", { name: `Opening ${openings.length}` })).toContainText("The dome creaks open.");
		await replace();
		await expect(page.getByText("Changes stay in this Chat", { exact: false })).toBeVisible();
		const replaced = (await (await request.get(url)).json()).cast.find(({ id }: { id: number }) => id === theodora.id);
		expect(replaced.name).toBe("Dr. Theodora Kline");
		expect(replaced.openings).toEqual(openings);
	});
});
