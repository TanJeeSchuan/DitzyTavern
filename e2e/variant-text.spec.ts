import { test, expect, story } from "./fixtures";
import { firstCall, isChatModelCall } from "./protocol";

test("a swipe the page left out shows its text and regenerates from it", async ({ page, request, llm }) => {
	const { activeChatId } = await (await request.get("/api/workspace")).json();
	const url = `/api/conversations/${activeChatId}`;
	const conversation = await (await request.get(url)).json();
	const created = await request.post(`${url}/commands`, { data: {
		expectedRevision: conversation.revision,
		action: { type: "create-message", timestamp: new Date(Date.UTC(2026, 0, 2)).toISOString(),
			authorParticipantId: conversation.control.humanParticipantId, variantContents: ["The first take.", "The second take."] },
	} });
	expect(created.ok()).toBe(true);
	const { messages } = await (await request.get(`${url}/history`)).json();
	const latest = messages.at(-1);
	const unselected = latest.variants.find((variant: { selected: boolean }) => !variant.selected);
	expect(unselected.content).toBeUndefined();
	const unselectedText = unselected.position === 1 ? "The first take." : "The second take.";

	await page.goto("/");
	const message = story(page).locator(`[data-message-id="${latest.id}"]`);
	await message.hover();
	await message.getByRole("button", { name: unselected.position === 1 ? "Previous Swipe" : "Next Swipe" }).click();
	await expect(message.getByText(unselectedText, { exact: true })).toBeVisible();

	await llm.chat({ chunks: ["The answer arrives."] });
	await message.hover();
	await message.getByRole("button", { name: "Regenerate response" }).click();
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(story(page).getByText("The answer arrives.", { exact: true })).toBeVisible();
	const call = firstCall((await llm.log()).calls, isChatModelCall);
	expect(JSON.stringify(call.body.messages)).toContain(unselectedText);
});
