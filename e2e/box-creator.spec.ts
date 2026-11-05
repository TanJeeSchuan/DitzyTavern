import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect, insertBox, openBoxes, send, story } from "./fixtures";
import { firstCall, isAuthoringModelCall, isChatModelCall } from "./protocol";

const descriptor = {
	sdk: 2, label: "Inventory", summary: "Keeps what the writer packs.", role: "system", startsEnabled: false, instructions: "",
	record: { type: "object", properties: { added: { type: "array", items: { type: "string" } } }, required: ["added"] },
	moves: { schema: { type: "object", properties: { item: { type: "string", minLength: 1, maxLength: 40 } }, required: ["item"] }, max: 4, label: "Pack {item}" },
	window: { icon: "box", size: { width: 18, height: 14 } },
};
const logic = `export default {
	moves: { render: ({ item }, author) => "(" + author + " packs a " + item + ".)" },
	records: { initial: [], fold: (items, { added }) => [...items, ...added] },
	read: ({ state }) => ({ view: { items: state } }),
	advance: { run: async ({ state, moves }) => {
		const items = [...state, ...moves.map((move) => move.item)];
		return { items: items.length === 0 ? [] : [{ text: "The pack holds: " + items.join(", ") + ".", priority: 0, pinned: true }], record: { added: moves.map((move) => move.item) } };
	} },
};`;
const ui = `let items = [];
let view = { moves: null, disabled: true };
const draw = () => host.render('<ul aria-label="Packed items">' + items.map((item) => '<li>' + item + '</li>').join("") + '</ul><button type="button" data-on="pack"' + (view.disabled || view.moves === null ? " disabled" : "") + '>Pack a lantern</button>');
host.onRead((read, next) => { items = read.items; view = next; draw(); });
host.onEvent(({ type, name }) => { if (type === "click" && name === "pack") host.stageMoves([{ item: "lantern" }]); });
draw();`;
const scenario = { cast: ["Night Desk", "Bard"], seed: "e2e", turns: [{ moves: [{ item: "rope" }] }, { moves: [{ item: "lantern" }] }] };

test("a Box written and checked by the coding agent installs without a restart, and resolves its Move into the Prompt Plan", async ({ page, request, llm }) => {
	const { revision } = await (await request.get("/api/connection-settings")).json();
	await request.post("/api/connection-settings/commands", { data: { type: "create-profile", expectedRevision: revision, profile: {
		displayName: "Coder", apiFormat: "chat-completions", requestUrl: `${llm.url}/__e2e/authoring/`, modelsUrl: `${llm.url}/__e2e/authoring/models`,
		modelBackend: "automatic", adapter: "openai-compatible", outputTokenRepresentation: "automatic", systemPlacement: "strict", timeoutMs: 60_000, pinnedModels: ["e2e-coder"],
	} } });
	await llm.authoring(
		{ tools: [
			{ name: "write_descriptor", arguments: { content: JSON.stringify(descriptor) } },
			{ name: "write_logic", arguments: { content: logic } },
			{ name: "write_ui", arguments: { content: ui } },
			{ name: "run_scenario", arguments: scenario },
		] },
		{ text: "The Inventory Box keeps what you pack. The scenario passed, so you can install it." },
	);
	await llm.chat({ chunks: ["The bard eyes the lantern."] });
	await page.goto("/");
	await insertBox(page, "Race");
	await page.getByRole("button", { name: "Race", exact: true }).click();
	const race = page.getByRole("dialog", { name: "Race", exact: true }).locator("iframe");
	await expect(race.contentFrame().locator("body")).not.toBeEmpty();
	await race.evaluate((frame) => frame.setAttribute("data-before-install", ""));

	const boxes = await openBoxes(page);
	await boxes.getByRole("button", { name: "Create a Box" }).click();
	const panel = page.getByRole("dialog", { name: "Create a Box" });
	await panel.getByRole("button", { name: "Coding model: Choose a model" }).click();
	await page.getByRole("option", { name: "e2e-coder", exact: true }).click();
	await panel.getByRole("button", { name: "Start" }).click();
	const message = panel.getByRole("textbox", { name: "Message to the coding agent" });
	await message.fill("An inventory the writer packs items into.");
	await message.press("Enter");

	const results = panel.getByRole("region", { name: "Scenario" });
	await expect(results.getByText("Passed", { exact: true })).toBeVisible();
	await expect(results.getByRole("list", { name: "Turn 1 prompt items" })).toHaveText("The pack holds: rope.0");
	await expect(results.getByRole("list", { name: "Turn 2 prompt items" })).toHaveText("The pack holds: rope, lantern.0");
	await expect(results.getByLabel("Window view")).toContainText('"lantern"');
	const log = panel.getByRole("list", { name: "Authoring conversation" });
	await expect(log).toContainText("The scenario passed, so you can install it.");
	await log.locator("summary", { hasText: "write_logic" }).click();
	await expect(log.getByLabel("logic.js as written")).toContainText('" packs a " + item');
	await message.fill("/files");
	await message.press("Enter");
	const files = log.getByRole("list", { name: "Files" });
	await expect(files.locator("summary")).toHaveText([/^descriptor\.json/, /^logic\.js/, /^ui\.js/]);
	await files.locator("summary", { hasText: "logic.js" }).click();
	await expect(files.getByLabel("logic.js", { exact: true })).toContainText('" packs a " + item');
	const { calls } = await llm.log();
	const authored = calls.filter(isAuthoringModelCall);
	expect(authored.map(({ body }) => body.model)).toEqual(["e2e-coder", "e2e-coder"]);
	expect(authored[0]?.body.tools?.map(({ function: { name } }) => name)).toEqual(["read_contract", "write_descriptor", "write_logic", "write_ui", "write_css", "run_scenario"]);
	expect(authored[1]?.body.messages.filter(({ role }) => role === "tool").at(-1)?.content).toContain("The pack holds: rope, lantern.");
	expect(calls.filter(isChatModelCall)).toEqual([]);

	await panel.getByRole("button", { name: "Install" }).click();
	await expect(log).toContainText("Inventory is installed. Add it to a Chat from the Box manager.");
	await page.keyboard.press("Escape");
	await expect(panel).toBeHidden();
	const authoring = join(await llm.directory(), "authoring");
	await expect.poll(() => readdirSync(authoring).flatMap((session) => readdirSync(join(authoring, session))).sort()).toEqual(["checkpoint.bin", "log.ndjson", "meta.json", expect.stringMatching(/^authored-/)].sort());

	// Closing the panel kept the session: it opens again with its conversation and its last scenario, without a model call.
	await boxes.getByRole("button", { name: "Create a Box" }).click();
	const saved = panel.getByRole("list", { name: "Saved sessions" }).getByRole("button");
	await expect(saved).toHaveText(["InventoryInstalled"]);
	await saved.click();
	await panel.getByRole("button", { name: "Open" }).click();
	await expect(panel.getByRole("list", { name: "Authoring conversation" })).toContainText("The scenario passed, so you can install it.");
	await expect(panel.getByRole("region", { name: "Scenario" }).getByRole("list", { name: "Turn 2 prompt items" })).toHaveText("The pack holds: rope, lantern.0");
	// Reopening never assumes the last run is the installed one: a session may hold a checked but uninstalled revision, and installing the current version again is a no-op.
	await expect(panel.getByRole("button", { name: "Install" })).toBeEnabled();
	await page.keyboard.press("Escape");
	await expect(panel).toBeHidden();
	expect((await llm.log()).calls.filter(isAuthoringModelCall)).toHaveLength(2);

	await insertBox(page, "Inventory");
	await page.getByRole("button", { name: "Inventory", exact: true }).click();
	const inventory = page.getByRole("dialog", { name: "Inventory" }).frameLocator("iframe");
	await inventory.getByRole("button", { name: "Pack a lantern" }).click();
	await expect(page.locator("form.composer").getByRole("list", { name: "Inventory Moves" }).getByRole("listitem")).toHaveText(["Pack lantern"]);
	await send(page, "Into the night.");
	await expect(story(page).getByText("The bard eyes the lantern.")).toBeVisible();
	await expect(inventory.getByRole("list", { name: "Packed items" })).toHaveText("lantern");
	const prompt = firstCall((await llm.log()).calls, isChatModelCall).body.messages.map(({ content }) => content).join("\n");
	expect(prompt).toContain("(Night Desk packs a lantern.)\nInto the night.");
	expect(prompt).toContain("The pack holds: lantern.");
	// The Race frame opened before Install is still the same element: installing a Box rebuilt no other Box's window.
	await expect(race).toHaveAttribute("data-before-install", "");
});
