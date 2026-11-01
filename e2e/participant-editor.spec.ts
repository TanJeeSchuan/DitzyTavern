import { test, expect } from "./fixtures";

test.use({ allowedBrowserErrors: /status of 409/ });

// @approved A Participant draft saves against the revision it was opened at,
// so a definition changed elsewhere meanwhile is never overwritten unseen.
test("a Participant saved after it changed elsewhere conflicts instead of overwriting", async ({ page, request }) => {
	const { activeChatId } = await (await request.get("/api/workspace")).json();
	const url = `/api/conversations/${activeChatId}`;
	const conversation = await (await request.get(url)).json();
	const participant = conversation.cast.find(({ name }: { name: string }) => name === "Theodora Kline");
	await page.goto("/");
	await page.getByRole("button", { name: "Characters" }).click();
	// The Cast row button precedes its row menu, so first() opens the editor.
	await page.getByRole("button", { name: /Theodora Kline maps coastlines/ }).first().click();
	await page.getByRole("textbox", { name: "Name" }).fill("Theodora Mine");

	const { prompt, openings } = participant;
	const changed = await request.post(`${url}/commands`, { data: {
		expectedRevision: conversation.revision,
		action: { type: "update-participant-definition", participantId: participant.id, definition: { name: "Theodora Theirs", prompt, openings } },
	} });
	expect(changed.ok()).toBe(true);
	const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === url);
	await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
	await refreshed;

	const saved = page.waitForResponse((response) => new URL(response.url()).pathname === `${url}/commands`);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await saved;
	const after = await (await request.get(url)).json();
	expect(after.cast.find(({ id }: { id: number }) => id === participant.id).name).toBe("Theodora Theirs");
	await expect(page.getByText("This Participant changed elsewhere after you opened it. Your edits were not saved and are still here.")).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Theodora Mine");

	await page.getByRole("button", { name: "Keep my edits" }).click();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	const kept = await (await request.get(url)).json();
	expect(kept.cast.find(({ id }: { id: number }) => id === participant.id).name).toBe("Theodora Mine");
});
