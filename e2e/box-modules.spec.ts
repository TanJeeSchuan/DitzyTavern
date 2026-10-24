import { test, expect, insertBox, send, story, openBoxes, closeBoxes } from "./fixtures";

test.use({ allowedBrowserErrors: /is broken/ });

test("a Box client module that fails to import or is malformed loses its surfaces, and the Box manager still turns the Box off", async ({ page }) => {
	await page.route("**/boxes/memory/client.js", async (route) => {
		const response = await route.fetch();
		await route.fulfill({ response, body: `${await response.text()}\nthrow new Error("The Memory client is broken.");` });
	});
	await page.route("**/boxes/thought/client.js", (route) => route.fulfill({ contentType: "text/javascript", body: `
		import thought from "/boxes/thought/client.js?original";
		export default { ...thought, Window: { ...thought.Window, size: undefined } };
	` }));
	await page.goto("/");
	const boxes = await openBoxes(page);
	const memory = boxes.getByRole("listitem").filter({ hasText: "Memory" });
	await expect(memory).toContainText("Did not load: The Memory client is broken.");
	await expect(boxes.getByRole("listitem").filter({ hasText: "Thoughts" })).toContainText("Did not load: Its client module is invalid at /Window/size");
	await expect(boxes.getByRole("switch", { name: "Thoughts in this Chat" })).not.toBeChecked();
	await memory.getByRole("switch", { name: "Memory in this Chat" }).click();
	await expect(memory.getByRole("switch", { name: "Memory in this Chat" })).not.toBeChecked();
	await expect(memory).toContainText("Off · setup kept");
	await boxes.getByRole("switch", { name: "Phone in this Chat" }).click();
	await closeBoxes(page);
	await expect(page.getByRole("group", { name: "Chat tools" }).getByRole("button", { name: "Memories", exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Phone", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "Phone" })).toBeVisible();
});

test("a Box client module that never finishes loading is refused at its deadline, and the Chat renders and still turns the Box off", async ({ page }) => {
	await page.clock.install();
	await page.route("**/boxes/memory/client.js", (route) => route.fulfill({ contentType: "text/javascript", body: "await new Promise(() => {});\nexport default {};" }));
	await page.goto("/", { waitUntil: "networkidle" });
	await page.clock.fastForward(10_000);
	await openBoxes(page);
	const memory = page.getByRole("list", { name: "Boxes" }).getByRole("listitem").filter({ hasText: "Memory" });
	await expect(memory).toContainText("Did not load: Its client module did not load within 10 seconds.");
	await memory.getByRole("switch", { name: "Memory in this Chat" }).click();
	await expect(memory).toContainText("Off · setup kept");
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

test("a lens whose output is malformed shows its failure beside the prose it left unlifted", async ({ page, llm }) => {
	await page.route("**/boxes/thought/client.js", (route) => route.fulfill({ contentType: "text/javascript", body: `
		import thought from "/boxes/thought/client.js?original";
		export default { ...thought, Window: { ...thought.Window, lens: { tag: "thought", gate: () => () => [{ kind: "prose" }] } } };
	` }));
	await llm.chat({ chunks: ["Theodora smiles.\n<thought>He knows.</thought>"] });
	await page.goto("/");
	await insertBox(page, "Thoughts");
	await send(page, "The night is quiet.");
	const reply = story(page).locator("article").last();
	await expect(reply.getByRole("alert")).toContainText("Thoughts failed: Its lens output is invalid");
	await expect(reply).toContainText("Theodora smiles.");
});
