import type { FrameLocator, Locator } from "@playwright/test";
import { test, expect, insertBox, send, story } from "./fixtures";
import { firstCall, isChatModelCall } from "./protocol";

// A restart cuts the open change stream mid-response.
test.use({ allowedBrowserErrors: /ERR_INCOMPLETE_CHUNKED_ENCODING/ });

// Both plugin kinds run the same flow: the trusted Tip Jar, built with `box:build`, renders in the window itself; the sandboxed one, three plain files, renders in its frame.
const plugins: readonly { readonly id: string; readonly kind: string; readonly panel: (jar: Locator) => Locator | FrameLocator }[] = [
	{ id: "tip-jar", kind: "trusted", panel: (jar) => jar },
	{ id: "tip-jar-sandboxed", kind: "sandboxed", panel: (jar) => jar.frameLocator("iframe") },
];

for (const { id, kind, panel } of plugins) test(`a ${kind} plugin Box installed into the plugin folder loads on restart, resolves its Move into a record, and keeps it across a restart`, async ({ page, llm }) => {
	await llm.installBox(id);
	await llm.restart("graceful");
	await llm.chat({ chunks: ["The bard bows to the room."] });
	await page.goto("/");
	await insertBox(page, "Tip Jar");
	await page.getByRole("button", { name: "Tip Jar", exact: true }).click();
	const jar = page.getByRole("dialog", { name: "Tip Jar" });
	const coins = panel(jar).getByRole("status", { name: "Coins in the jar" });
	await expect(coins).toHaveText("0");
	await expect(panel(jar).locator(".tip-jar")).toHaveCSS("display", "grid");
	await expect(panel(jar).locator(".tip-jar")).toHaveCSS("border-radius", "7px");

	await panel(jar).getByRole("button", { name: "Drop a coin" }).click();
	await expect(page.locator("form.composer").getByRole("list", { name: "Tip Jar Moves" }).getByRole("listitem")).toHaveText(["Tip 1"]);
	await send(page, "A song for the bard.");
	await expect(story(page).getByText("The bard bows to the room.")).toBeVisible();
	await expect(coins).toHaveText("1");
	const call = firstCall((await llm.log()).calls, isChatModelCall);
	const prompt = call.body.messages.map(({ content }) => content).join("\n");
	expect(prompt).toContain("(Night Desk drops 1 coin in the tip jar.)\nA song for the bard.");
	expect(prompt).toContain("The tip jar holds 1 coins.");

	await llm.restart("graceful");
	await page.reload();
	await expect(coins).toHaveText("1");
});
