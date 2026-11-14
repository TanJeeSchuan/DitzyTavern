import type { APIRequestContext } from "@playwright/test";
import { test, expect, story, openBoxes, closeBoxes } from "./fixtures";

const MESSAGES = 150;
const passage = (position: number, take: number) => Array.from({ length: 6 }, (_, line) =>
	`Take ${take} of passage ${position}, line ${line}: the lantern gutters as *rain* needles the shutters, and **someone** knocks twice before the bolt slides back.`).join("\n\n");

const writeLongChat = async (request: APIRequestContext) => {
	const { activeChatId } = await (await request.get("/api/workspace")).json();
	let conversation = await (await request.get(`/api/conversations/${activeChatId}`)).json();
	const { humanParticipantId, modelParticipantId } = conversation.control;
	for (let position = 1; position <= MESSAGES; position++) {
		const human = position % 2 === 1;
		const action = {
			type: "create-message",
			timestamp: new Date(Date.UTC(2026, 0, 1, 0, position)).toISOString(),
			authorParticipantId: human ? humanParticipantId : modelParticipantId,
			variantContents: human ? [passage(position, 1)] : [1, 2, 3].map((take) => passage(position, take)),
		};
		const response = await request.post(`/api/conversations/${activeChatId}/commands`, { data: { expectedRevision: conversation.revision, action } });
		expect(response.ok()).toBe(true);
		({ conversation } = await response.json());
	}
};

// The detector in the fixture does the judging; this test only supplies a heavy Chat on a mid-range phone's CPU.
test("a long Chat answers every action within the Doherty Threshold on a 4x slower CPU", async ({ page, request }) => {
	await writeLongChat(request);
	await page.goto("/");
	const articles = story(page).locator("article[data-message-id]");
	await expect(articles).toHaveCount(50);
	await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: 4 });

	await page.getByRole("textbox", { name: "Message draft" }).pressSequentially("The lantern gutters.");
	const last = articles.last();
	for (const [swipe, take] of [["Next Swipe", 2], ["Next Swipe", 3], ["Previous Swipe", 2]] as const) {
		await last.getByRole("button", { name: swipe, exact: true }).click();
		await expect(last.getByText(`Take ${take} of passage 150, line 0`, { exact: false })).toBeVisible();
	}
	for (const count of [100, MESSAGES]) {
		await story(page).getByRole("button", { name: "Load more Messages", exact: true }).click();
		await expect(articles).toHaveCount(count);
	}
	await openBoxes(page);
	await closeBoxes(page);
});
