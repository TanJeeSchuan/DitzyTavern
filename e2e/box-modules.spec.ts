import type { Page } from "@playwright/test";
import { test, expect, insertBox, send, story, openBoxes, closeBoxes } from "./fixtures";

test.use({ allowedBrowserErrors: /is broken/ });

const openPanel = async (page: Page, name: string) => {
	const navigation = page.getByRole("button", { name: "Open navigation", exact: true });
	if (await navigation.isVisible()) await navigation.click();
	await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name, exact: true }).click();
};

const openPromptPresets = async (page: Page) => {
	await openPanel(page, "Prompt Presets");
	return page.getByRole("region", { name: "Preset contents", exact: true });
};

test("a Box client module that fails to import or is malformed loses its surfaces, and its Decision Model settings and preset copy stay", async ({ page }) => {
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
	await boxes.getByRole("button", { name: "Add Thoughts", exact: true }).click();
	await expect(boxes.getByRole("switch", { name: "Thoughts in this Chat" })).toBeChecked();
	await memory.getByRole("switch", { name: "Memory in this Chat" }).click();
	await expect(memory.getByRole("switch", { name: "Memory in this Chat" })).not.toBeChecked();
	await boxes.getByRole("button", { name: "Add Phone", exact: true }).click();
	await closeBoxes(page);
	await expect(page.getByRole("group", { name: "Chat tools" }).getByRole("button", { name: "Memories", exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Phone", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "Phone" })).toBeVisible();
	await page.getByRole("dialog", { name: "Phone" }).getByRole("button", { name: "Close Phone", exact: true }).click();

	const contents = await openPromptPresets(page);
	await contents.getByRole("button", { name: "Edit Memory", exact: true }).click();
	const memoryEditor = page.getByRole("dialog", { name: "Memory", exact: true });
	await expect(memoryEditor).toContainText("Uses Conversation Memories recalled when a Generation is assembled.");
	await expect(memoryEditor).toContainText("Conversation Memories");
	await expect(memoryEditor.getByRole("textbox", { name: "Instructions" })).toHaveValue("");
	await expect(memoryEditor.getByRole("button", { name: "Reset to Memory default", exact: true })).toBeDisabled();
	await expect(memoryEditor.getByText("Memory content goes here")).toBeVisible();
	await memoryEditor.getByRole("button", { name: "Close", exact: true }).click();

	await contents.getByRole("button", { name: "Edit Thoughts", exact: true }).click();
	const thoughtsEditor = page.getByRole("dialog", { name: "Thoughts", exact: true });
	await expect(thoughtsEditor).toContainText("Uses the Thoughts Box when it is enabled in this Chat.");
	await expect(thoughtsEditor).toContainText("This Chat");
	const instructions = thoughtsEditor.getByRole("textbox", { name: "Instructions" });
	const fallbackText = await instructions.inputValue();
	expect(fallbackText.length).toBeGreaterThan(0);
	await instructions.fill("Edited after its client module was refused.");
	await expect(thoughtsEditor.getByRole("button", { name: "Reset to Thoughts default", exact: true })).toBeEnabled();
	await thoughtsEditor.getByRole("button", { name: "Reset to Thoughts default", exact: true }).click();
	await expect(instructions).toHaveValue(fallbackText);
	await thoughtsEditor.getByRole("button", { name: "Close", exact: true }).click();

	await openPanel(page, "Connections");
	const region = page.getByRole("region", { name: "Memory", exact: true });
	await expect(region).toContainText("Judges the Memories extraction proposes and scores saved Memories for recall.");
	await region.getByRole("button").click();
	await expect(page.getByRole("button", { name: "Memory Decision Model: Choose a model", exact: true })).toBeVisible();
	await expect(page.getByText("Each Message is read with up to four Messages before it.")).toBeVisible();
	await expect(page.getByText("Without one, Memory remembers and recalls nothing.")).toBeVisible();
});

test("a Box client module that never finishes loading is refused at its deadline, and the Chat renders with the Box's preset copy", async ({ page }) => {
	await page.clock.install();
	await page.route("**/boxes/memory/client.js", (route) => route.fulfill({ contentType: "text/javascript", body: "await new Promise(() => {});\nexport default {};" }));
	await page.goto("/", { waitUntil: "networkidle" });
	await page.clock.fastForward(10_000);
	await page.clock.resume();
	await openBoxes(page);
	const memory = page.getByRole("group", { name: "Boxes" }).getByRole("listitem").filter({ hasText: "Memory" });
	await expect(memory).toContainText("Did not load: Its client module did not load within 10 seconds.");
	await memory.getByRole("switch", { name: "Memory in this Chat" }).click();
	await expect(memory.getByRole("switch", { name: "Memory in this Chat" })).not.toBeChecked();
	await closeBoxes(page);
	const contents = await openPromptPresets(page);
	await contents.getByRole("button", { name: "Edit Memory", exact: true }).click();
	const memoryEditor = page.getByRole("dialog", { name: "Memory", exact: true });
	await expect(memoryEditor).toContainText("Uses Conversation Memories recalled when a Generation is assembled.");
	await expect(memoryEditor.getByText("Memory content goes here")).toBeVisible();
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
