import { test, expect, insertBox, send, story } from "./fixtures";
import { isChatModelCall } from "./protocol";

test("a plugin Box installed into the plugin folder loads on restart, resolves its Move into a record, and keeps it across a restart", async ({ page, llm }) => {
	await llm.installBox("tip-jar");
	await llm.restart("graceful");
	await llm.chat({ chunks: ["The bard bows to the room."] });
	await page.goto("/");
	await insertBox(page, "Tip Jar");
	await page.getByRole("button", { name: "Tip Jar", exact: true }).click();
	const jar = page.getByRole("dialog", { name: "Tip Jar" });
	const coins = jar.getByRole("status", { name: "Coins in the jar" });
	await expect(coins).toHaveText("0");
	await expect(jar.locator(".tip-jar")).toHaveCSS("display", "grid");
	await expect(jar.locator(".tip-jar")).toHaveCSS("border-radius", "7px");

	await jar.getByRole("button", { name: "Drop a coin" }).click();
	await expect(page.locator("form.composer").getByRole("list", { name: "Tip Jar Moves" }).getByRole("listitem")).toHaveText(["🪙 1"]);
	await send(page, "A song for the bard.");
	await expect(story(page).getByText("The bard bows to the room.")).toBeVisible();
	await expect(coins).toHaveText("1");
	const [call] = (await llm.log()).calls.filter(isChatModelCall);
	const prompt = call.body.messages.map(({ content }) => content).join("\n");
	expect(prompt).toContain("(Night Desk drops 1 coin in the tip jar.)\nA song for the bard.");
	expect(prompt).toContain("The tip jar holds 1 coins.");

	await llm.restart("graceful");
	await page.reload();
	await expect(coins).toHaveText("1");
});
