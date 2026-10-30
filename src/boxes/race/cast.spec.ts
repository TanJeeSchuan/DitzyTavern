import type { Page } from "@playwright/test";
import { test, expect, story, insertBox } from "../../../e2e/fixtures";
import type { ConversationAction } from "../../shared/contract/conversation-schema";

const raceItem = async (page: Page) => {
	const preview = page.getByRole("complementary", { name: "Prompt Plan preview" });
	await preview.getByText(/^Race ·/).click();
	return preview.getByRole("textbox", { name: /^box:race block/ }).innerText();
};

const emptyPrompt = () => ({ systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" });

// @approved One Cast member's stats are written once, seed a new Chat's copy,
// and stay hers when the Character changes afterwards.
test("a Cast Runner's stats copy on seeding and survive Character edits", async ({ page, request, llm }) => {
	test.setTimeout(120_000);
	await llm.chat({ chunks: ["The field breaks from the gate."] });
	const workspace = await (await request.get("/api/workspace")).json();
	const chatId: number = workspace.activeChatId;
	const conversation = await (await request.get(`/api/conversations/${chatId}`)).json();
	const runner = conversation.cast.find((participant: { id: number; sourceCharacterId: number | null }) =>
		participant.sourceCharacterId !== null && participant.id !== conversation.control.humanParticipantId);

	await page.goto("/");
	await insertBox(page, "Race");
	await page.getByRole("button", { name: "Race", exact: true }).click();
	const window = page.getByRole("dialog", { name: "Race", exact: true });
	await window.getByRole("button", { name: runner.name, exact: true }).click();
	const sheet = window.getByRole("region", { name: `Stats for ${runner.name}` });
	const setStat = (label: string, value: number) => sheet.getByRole("spinbutton", { name: label }).fill(String(value));
	await setStat("Speed", 777);
	await setStat("Stamina", 666);
	await setStat("Power", 555);
	await setStat("Guts", 444);
	await setStat("Wit", 333);
	await sheet.getByRole("switch", { name: `Save to ${runner.name}` }).click();
	await sheet.getByRole("button", { name: "Add to field" }).click();
	await expect(sheet).toHaveCount(0);
	await window.getByRole("button", { name: "Fill field" }).click();
	await expect(window.getByRole("list", { name: "Race field" }).getByRole("listitem")).toHaveCount(8);
	await window.getByRole("button", { name: "Start race" }).click();
	await expect(window.getByRole("button", { name: "New race" })).toBeVisible();

	await page.getByRole("textbox", { name: "Message draft" }).fill("They are off.");
	await page.getByRole("button", { name: "Generate Variant" }).click();
	expect(await raceItem(page)).toContain(runner.name);
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(story(page).getByText("The field breaks from the gate.", { exact: true })).toBeVisible();

	// Participant stats persist across races in the same Chat.
	await window.getByRole("button", { name: "New race" }).click();
	await window.getByRole("button", { name: runner.name, exact: true }).click();
	await expect(sheet.getByRole("spinbutton", { name: "Speed" })).toHaveValue("777");
	await sheet.getByRole("button", { name: "Cancel" }).click();

	// A new Chat seeded from the Character copies its declared Participant data.
	const characters = await (await request.get("/api/characters")).json();
	const character = characters.characters.find((entry: { id: number }) => entry.id === runner.sourceCharacterId);
	const created = await (await request.post("/api/conversations/native", { data: {
		name: "Second stable",
		humanSeat: { type: "adhoc", definition: { name: "Writer", prompt: emptyPrompt(), openings: [] } },
		modelSeat: { type: "character", characterId: character.id, expectedRevision: character.revision },
	} })).json();
	expect(created.outcome).toBe("created");
	await page.goto("/");
	expect((await (await request.get("/api/workspace")).json()).activeChatId).toBe(created.conversation.id);
	await insertBox(page, "Race");
	await page.getByRole("button", { name: "Race", exact: true }).click();
	const second = page.getByRole("dialog", { name: "Race", exact: true });
	await second.getByRole("button", { name: runner.name, exact: true }).click();
	const copied = second.getByRole("region", { name: `Stats for ${runner.name}` });
	await expect(copied.getByRole("spinbutton", { name: "Speed" })).toHaveValue("777");

	// Editing the Character afterwards never reaches the first Participant.
	await copied.getByRole("spinbutton", { name: "Speed" }).fill("111");
	await copied.getByRole("switch", { name: `Save to ${runner.name}` }).click();
	await copied.getByRole("button", { name: "Add to field" }).click();
	await expect(copied).toHaveCount(0);
	const firstRead = await (await request.get(`/api/conversations/${chatId}/boxes/race`)).json();
	expect(firstRead.castStats.find((entry: { participantId: number }) => entry.participantId === runner.id).stats.speed).toBe(777);
});

test.describe("a Character stats save from a stale read", () => {
	// The refused save answers 422, which logs one browser console error.
	test.use({ allowedBrowserErrors: /status of 422/ });

	// @approved Another Chat saving the Character's stats refuses this sheet's
	// save once, and the retry goes through without losing its edits.
	test("Add is refused once, then the retry saves to the Character", async ({ page, request }) => {
		const { activeChatId } = await (await request.get("/api/workspace")).json();
		const conversation = await (await request.get(`/api/conversations/${activeChatId}`)).json();
		const runner = conversation.cast.find((participant: { id: number; sourceCharacterId: number | null }) =>
			participant.sourceCharacterId !== null && participant.id !== conversation.control.humanParticipantId);

		await page.goto("/");
		await insertBox(page, "Race");
		await page.getByRole("button", { name: "Race", exact: true }).click();
		const window = page.getByRole("dialog", { name: "Race", exact: true });
		await window.getByRole("button", { name: runner.name, exact: true }).click();
		const sheet = window.getByRole("region", { name: `Stats for ${runner.name}` });
		await sheet.getByRole("spinbutton", { name: "Speed" }).fill("777");
		await sheet.getByRole("switch", { name: `Save to ${runner.name}` }).click();

		const characters = await (await request.get("/api/characters")).json();
		const character = characters.characters.find((entry: { id: number }) => entry.id === runner.sourceCharacterId);
		const created = await (await request.post("/api/conversations/native", { data: {
			name: "Second stable",
			humanSeat: { type: "adhoc", definition: { name: "Writer", prompt: emptyPrompt(), openings: [] } },
			modelSeat: { type: "character", characterId: character.id, expectedRevision: character.revision },
		} })).json();
		const elsewhere = created.conversation;
		const command = async (expectedRevision: number, action: ConversationAction) =>
			(await (await request.post(`/api/conversations/${elsewhere.id}/commands`, { data: { expectedRevision, action } })).json()).conversation.revision;
		const enabled = await command(elsewhere.revision, { type: "set-box-state", box: "race", state: "enabled" });
		await command(enabled, { type: "put-box-data", box: "race", owner: { type: "character", characterId: character.id, revision: 0 }, key: "stats", value: "{\"speed\":111}" });

		await sheet.getByRole("button", { name: "Add to field" }).click();
		await expect(window.getByRole("alert")).toBeVisible();
		await expect(sheet.getByRole("spinbutton", { name: "Speed" })).toHaveValue("777");
		await sheet.getByRole("button", { name: "Add to field" }).click();
		await expect(sheet).toHaveCount(0);
		await expect(window.getByRole("list", { name: "Race field" })).toContainText(runner.name);
		const read = await (await request.get(`/api/conversations/${elsewhere.id}/boxes/race`)).json();
		expect(read.characterStatsRevisions[character.id]).toBe(2);
	});
});
