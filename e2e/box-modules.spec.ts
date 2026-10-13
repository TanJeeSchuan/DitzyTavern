import { test, expect, send, story } from "./fixtures";

test.use({ allowedBrowserErrors: /is broken/ });

test("a Box client module that fails to import or is malformed is listed in the Box manager without its surfaces", async ({ page }) => {
	await page.route("**/boxes/memory/client.js", async (route) => {
		const response = await route.fetch();
		await route.fulfill({ response, body: `${await response.text()}\nthrow new Error("The Memory client is broken.");` });
	});
	await page.route("**/boxes/thought/client.js", (route) => route.fulfill({ contentType: "text/javascript", body: `
		import thought from "/boxes/thought/client.js?original";
		export default { ...thought, Window: { ...thought.Window, size: undefined } };
	` }));
	await page.goto("/");
	await page.getByRole("button", { name: "Boxes", exact: true }).click();
	const boxes = page.getByRole("list", { name: "Boxes" });
	await expect(boxes.getByRole("listitem").filter({ hasText: "memory" })).toContainText("Did not load: The Memory client is broken.");
	await expect(boxes.getByRole("listitem").filter({ hasText: "thought" })).toContainText("Did not load: Its client module is invalid at /Window/size");
	await expect(boxes.getByRole("switch", { name: "Memory in this Chat" })).toHaveCount(0);
	await expect(boxes.getByRole("switch", { name: "Thoughts in this Chat" })).toHaveCount(0);
	await boxes.getByRole("switch", { name: "Phone in this Chat" }).click();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("group", { name: "Chat tools" }).getByRole("button", { name: "Memories", exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Phone", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "Phone" })).toBeVisible();
});

test("a Box surface or icon that throws shows its failure in its frame, and the rest of the Chat keeps working", async ({ page, llm }) => {
	await page.route("**/boxes/memory/client.js", (route) => route.fulfill({ contentType: "text/javascript", body: `
		import memory from "/boxes/memory/client.js?original";
		export default {
			...memory,
			icon: () => { throw new Error("The Memory icon is broken."); },
			Inspector: { ...memory.Inspector, Component: () => { throw new Error("The Memories inspector is broken."); } },
		};
	` }));
	await llm.chat({ chunks: ["The lantern stays lit."] });
	await page.goto("/");
	await expect(page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Memory", exact: true })).toBeVisible();
	await page.getByRole("group", { name: "Chat tools" }).getByRole("button", { name: "Memories", exact: true }).click();
	const inspector = page.getByRole("complementary", { name: "Memories" });
	await expect(inspector.getByRole("alert")).toHaveText("Memory failed: The Memories inspector is broken.");
	await inspector.getByRole("button", { name: "Close Memories", exact: true }).click();
	await expect(inspector).toHaveCount(0);
	await send(page, "Watch the lantern.");
	await expect(story(page).getByText("The lantern stays lit.")).toBeVisible();
});
