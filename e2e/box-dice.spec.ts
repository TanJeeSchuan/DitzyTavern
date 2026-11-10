import { test, expect, insertBox, send, story } from "./fixtures";
import { firstCall, isChatModelCall } from "./protocol";

// A restart cuts the open change stream mid-response, and three.js logs why a browser without a GPU gives it no WebGL context.
test.use({ allowedBrowserErrors: /ERR_INCOMPLETE_CHUNKED_ENCODING|THREE\.WebGLRenderer: (?:A WebGL context could not be created|Error creating WebGL context)/ });

// @approved
//  The Dice Box ships three.js pinned in its `deps/`, so the server builds it
// with no network. Its UI bundle starts three.js in the frame's Worker and
// draws on the canvas the frame transferred. CI has no GPU, so either
// renderer state proves the transfer. Each later render keeps the canvas in
// place, so a click after them still reaches the Worker.
test("a sandboxed Box built with a pinned package draws on a transferred canvas, and a click on it stages a Move whose roll reaches the prompt", async ({ page, llm }) => {
	await llm.installBox("dice-3d");
	await llm.restart("graceful");
	await llm.chat({ chunks: ["The die clatters across the table."] });
	await page.goto("/");
	await insertBox(page, "Dice");
	await page.getByRole("button", { name: "Dice", exact: true }).click();
	const frame = page.getByRole("dialog", { name: "Dice" }).frameLocator("iframe");
	await expect(frame.getByRole("status", { name: "Renderer" })).toHaveText(/^WebGL (?:ready|unavailable)$/);

	const moves = page.locator("form.composer").getByRole("list", { name: "Dice Moves" }).getByRole("listitem");
	await frame.getByLabel("Die").click();
	await expect(moves).toHaveText(["Roll d6"]);
	await send(page, "Roll for initiative.");
	await expect(story(page).getByText("The die clatters across the table.")).toBeVisible();
	const face = frame.getByRole("status", { name: "Face" });
	await expect(face).toHaveText(/^[1-6]$/);
	const prompt = firstCall((await llm.log()).calls, isChatModelCall).body.messages.map(({ content }) => content).join("\n");
	expect(prompt).toContain("(Night Desk rolls a d6.)\nRoll for initiative.");
	expect(prompt).toContain(`The die shows ${await face.textContent()}.`);

	await frame.getByLabel("Die").click();
	await expect(moves).toHaveText(["Roll d6"]);
});
