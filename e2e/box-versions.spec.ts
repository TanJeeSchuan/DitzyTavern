import type { Page } from "@playwright/test";
import { test, expect, closeBoxes, insertBox, openBoxes, send, story } from "./fixtures";
import { isChatModelCall } from "./protocol";

const descriptor = {
	sdk: 2, label: "Coin Jar", summary: "Counts the coins the writer tips.", role: "system", startsEnabled: false, instructions: "",
	record: { type: "object", properties: { coins: { type: "integer", minimum: 0 } }, required: ["coins"] },
	moves: { schema: { type: "object", properties: { coins: { type: "integer", minimum: 1 } }, required: ["coins"] }, max: 1, label: "Tip {coins}" },
	window: { icon: "coins", size: { width: 18, height: 12 } },
};
/** @approved One version of the Coin Jar: its prompt item and its window name the version they belong to. */
const logic = (jar: string) => `export default {
	moves: { render: ({ coins }, author) => "(" + author + " tips " + coins + ".)" },
	records: { initial: 0, fold: (total, { coins }) => total + coins },
	read: ({ state }) => ({ view: { coins: state } }),
	advance: { run: async ({ state, moves }) => {
		const coins = moves.reduce((sum, move) => sum + move.coins, 0);
		return { items: [{ text: "${jar} holds " + (state + coins) + ".", priority: 0, pinned: true }], record: { coins } };
	} },
};`;
const ui = (jar: string) => `let coins = 0;
let view = { moves: null, disabled: true };
const draw = () => host.render('<p>${jar}: ' + coins + ' coins</p><button type="button" data-on="tip"' + (view.disabled || view.moves === null ? " disabled" : "") + '>Tip a coin</button>');
host.onRead((read, next) => { coins = read.coins; view = next; draw(); });
host.onEvent(({ type, name }) => { if (type === "click" && name === "tip") host.stageMoves([{ coins: 1 }]); });
draw();`;
const scenario = { cast: ["Night Desk", "Bard"], seed: "e2e", turns: [{ moves: [{ coins: 1 }] }] };

const jar = (page: Page) => page.getByRole("dialog", { name: "Coin Jar" }).frameLocator("iframe");
const openJar = async (page: Page) => {
	if (await page.locator(".box-manager").isVisible()) await closeBoxes(page);
	await page.getByRole("button", { name: "Coin Jar", exact: true }).click();
};

test("a revised Box installs as a new version: Chats keep theirs until Update, which remounts the window and keeps the records folding", async ({ page, request, llm }) => {
	const { revision } = await (await request.get("/api/connection-settings")).json();
	await request.post("/api/connection-settings/commands", { data: { type: "create-profile", expectedRevision: revision, profile: {
		displayName: "Coder", apiFormat: "chat-completions", requestUrl: `${llm.url}/__e2e/authoring/`, modelsUrl: `${llm.url}/__e2e/authoring/models`,
		modelBackend: "automatic", adapter: "openai-compatible", outputTokenRepresentation: "automatic", systemPlacement: "strict", timeoutMs: 60_000, pinnedModels: ["e2e-coder"],
	} } });
	await llm.authoring(
		{ tools: [
			{ name: "write_descriptor", arguments: { content: JSON.stringify(descriptor) } },
			{ name: "write_logic", arguments: { content: logic("The jar") } },
			{ name: "write_ui", arguments: { content: ui("First jar") } },
			{ name: "run_scenario", arguments: scenario },
		] },
		{ text: "The Coin Jar counts tips. The scenario passed, so you can install it." },
		{ tools: [
			{ name: "write_logic", arguments: { content: logic("The second jar") } },
			{ name: "write_ui", arguments: { content: ui("Second jar") } },
			{ name: "run_scenario", arguments: scenario },
		] },
		{ text: "The jar is revised. The scenario passed, so you can install it." },
	);
	await llm.chat({ chunks: ["Coins clink into the jar."] }, { chunks: ["The jar glints."] });
	await page.goto("/");
	const { activeChatId, chats } = await (await request.get("/api/workspace")).json();
	const first: string = chats.find(({ id }: { id: number }) => id === activeChatId).name;

	const boxes = await openBoxes(page);
	await boxes.getByRole("button", { name: "Create a Box" }).click();
	const panel = page.getByRole("dialog", { name: "Create a Box" });
	await panel.getByRole("button", { name: "Coding model: Choose a model" }).click();
	await page.getByRole("option", { name: "e2e-coder", exact: true }).click();
	await panel.getByRole("button", { name: "Start" }).click();
	const message = panel.getByRole("textbox", { name: "Message to the coding agent" });
	await message.fill("A jar the writer tips coins into.");
	await message.press("Enter");
	const log = panel.getByRole("list", { name: "Authoring conversation" });
	await expect(log).toContainText("The scenario passed, so you can install it.");
	await panel.getByRole("button", { name: "Install" }).click();
	await expect(log).toContainText("Coin Jar is installed.");
	await page.keyboard.press("Escape");
	await expect(panel).toBeHidden();

	await insertBox(page, "Coin Jar");
	await openJar(page);
	await expect(jar(page).getByText("First jar: 0 coins")).toBeVisible();
	await jar(page).getByRole("button", { name: "Tip a coin" }).click();
	await send(page, "A coin for the bard.");
	await expect(story(page).getByText("Coins clink into the jar.")).toBeVisible();
	await expect(jar(page).getByText("First jar: 1 coins")).toBeVisible();
	await jar(page).locator("body").evaluate((body) => body.setAttribute("data-first", ""));
	// A second tab on the same Chat loads while v1 is latest.
	const other = await page.context().newPage();
	await other.goto("/");
	await expect(story(other).getByRole("heading", { name: first })).toBeVisible();

	await (await openBoxes(page)).getByRole("button", { name: "Create a Box" }).click();
	await panel.getByRole("list", { name: "Saved sessions" }).getByRole("button").click();
	await panel.getByRole("button", { name: "Open" }).click();
	await expect(panel.getByRole("button", { name: "Install" })).toBeEnabled();
	await message.fill("Call it the second jar.");
	await message.press("Enter");
	await expect(log).toContainText("The jar is revised.");
	await expect(log.getByText("Coin Jar is installed.")).toHaveCount(0);
	await panel.getByRole("button", { name: "Install" }).click();
	await expect(log.getByText("Coin Jar is installed.")).toHaveCount(1);
	await page.keyboard.press("Escape");
	await expect(panel).toBeHidden();

	// The Chat that held v1 still runs it: its frame is the same element, and the Box manager offers the update.
	await expect(jar(page).locator("body")).toHaveAttribute("data-first", "");
	await expect(jar(page).getByText("First jar: 1 coins")).toBeVisible();
	const row = (await openBoxes(page)).getByRole("listitem").filter({ hasText: "Coin Jar" });
	await expect(row).toContainText("Update available");
	// The other tab learns of v2 when its Box manager opens, though its Chat's pin resolved all along.
	await expect((await openBoxes(other)).getByRole("listitem").filter({ hasText: "Coin Jar" })).toContainText("Update available");
	await other.close();

	// A new Chat starts on v2.
	const emptyPrompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
	expect((await (await request.post("/api/conversations/native", { data: {
		name: "Fresh Jar Chat",
		humanSeat: { type: "adhoc", definition: { name: "Writer", prompt: emptyPrompt, openings: [] } },
		modelSeat: { type: "adhoc", definition: { name: "Maren", prompt: emptyPrompt, openings: [] } },
	} })).json()).outcome).toBe("created");
	await page.goto("/");
	await expect(story(page).getByRole("heading", { name: "Fresh Jar Chat" })).toBeVisible();
	await insertBox(page, "Coin Jar");
	await openJar(page);
	await expect(jar(page).getByText("Second jar: 0 coins")).toBeVisible();
	await expect((await openBoxes(page)).getByRole("listitem").filter({ hasText: "Coin Jar" })).not.toContainText("Update available");

	// Update moves the first Chat to v2: its window remounts on v2, and its v1 record still folds.
	await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Chats", exact: true }).click();
	await page.getByRole("button", { name: new RegExp(`^${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).click();
	await expect(story(page).getByRole("heading", { name: first })).toBeVisible();
	await openJar(page);
	await expect(jar(page).getByText("First jar: 1 coins")).toBeVisible();
	await (await openBoxes(page)).getByRole("button", { name: "Update Coin Jar" }).click();
	await expect(jar(page).getByText("Second jar: 1 coins")).toBeVisible();
	await expect((await openBoxes(page)).getByRole("listitem").filter({ hasText: "Coin Jar" })).not.toContainText("Update available");

	await jar(page).getByRole("button", { name: "Tip a coin" }).click();
	await send(page, "Another coin.");
	await expect(story(page).getByText("The jar glints.")).toBeVisible();
	const prompts = (await llm.log()).calls.filter(isChatModelCall).map(({ body }) => body.messages.map(({ content }) => content).join("\n"));
	expect(prompts[0]).toContain("The jar holds 1.");
	expect(prompts.at(-1)).toContain("The second jar holds 2.");
	expect(prompts.at(-1)).not.toContain("The jar holds");
});
