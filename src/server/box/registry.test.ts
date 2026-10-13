import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { boxDescriptors } from "../../shared/contract/box";
import { boxSdkVersion } from "../../shared/contract/box-descriptor";
import { createConversationRoutes } from "../contract/conversation";
import { captureModelFetch, createChat, duplicateBlock, key, readConversation, readInspection, readPreset, startGeneration, withProfile } from "../contract/prompt-preset-test-fixtures";
import { insertBox, openObservedDatabase } from "../test-fixtures/conversation";
import { builtInBoxes, captureBoxes, discoverBoxes, fingerprintBoxes, loadBoxes } from "./registry";

test("a Phone contact added after inspection makes the plan stale", () => {
	const human = { id: 1, name: "Ann" };
	const capture = (cast: readonly { id: number; name: string }[]) => fingerprintBoxes(captureBoxes(
		[{ reference: "box:phone", enabled: true, role: "system", content: "" }],
		{},
		{ "author-note": "absent", memory: "absent", mood: "absent", phone: "enabled", race: "absent", thought: "absent", "world-clock": "absent" },
		{},
		{},
		// SAFETY: Phone reads nothing through the database.
		{ database: {} as Database, conversationId: 1, seed: "seed", intent: "respond", human, cast, messages: [], pending: undefined },
	));
	expect(capture([human, { id: 2, name: "Bo" }])).not.toBe(capture([human, { id: 2, name: "Bo" }, { id: 3, name: "Cy" }]));
});

const lantern = { sdk: boxSdkVersion, label: "Lantern", role: "system", startsEnabled: false, instructions: "" };
const pluginFolders: string[] = [];
afterEach(() => { for (const folder of pluginFolders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
// @approved
//  Each plugin's descriptor is the Lantern's under its folder's name, with
// `fields`, as source, written over it.
const installPlugins = (plugins: Record<string, { readonly fields?: string; readonly server?: string }>) => {
	const root = mkdtempSync(join(tmpdir(), "ditzy-boxes-"));
	pluginFolders.push(root);
	for (const [name, { fields = "", server = "export default {};" }] of Object.entries(plugins)) {
		mkdirSync(join(root, name));
		writeFileSync(join(root, name, "shared-descriptor.ts"), `export default { ...${JSON.stringify({ id: name, ...lantern })}, ${fields} };`);
		writeFileSync(join(root, name, "server.ts"), server);
	}
	return root;
};

test("a plugin Box that cannot load is refused with its reason, and the rest still load", async () => {
	const plugins = installPlugins({
		lantern: {},
		unlabelled: { fields: "label: 3" },
		unschemed: { fields: "setup: { schema: {}, initial: null }" },
		"bad-initial": { fields: 'setup: { schema: { [Symbol.for("TypeBox.Kind")]: "String", type: "string" }, initial: 3 }' },
		"old-sdk": { fields: `sdk: ${boxSdkVersion - 1}` },
		mood: {},
		renamed: { fields: 'id: "lantern"' },
		broken: { server: 'throw new Error("The wick is wet.");' },
		unhooked: { fields: 'decision: { summary: "", description: "", off: "", context: "" }' },
	});
	const { boxes, refused } = await discoverBoxes([builtInBoxes, plugins]);
	expect(boxes.map(({ descriptor }) => descriptor.id)).toEqual([...boxDescriptors().keys(), "lantern"]);
	expect(refused.map(({ folder, reason }) => [basename(folder), reason])).toEqual([
		["bad-initial", "Its initial setup does not match its setup schema."],
		["broken", "The wick is wet."],
		["mood", "A Box with the id mood is already loaded."],
		["old-sdk", `It was built for Box SDK ${boxSdkVersion - 1}; this host runs ${boxSdkVersion}.`],
		["renamed", "Its folder must be named for its id, lantern."],
		["unhooked", "The unhooked Box must declare a digest exactly when it declares a decision."],
		["unlabelled", "Its descriptor is invalid at /label: Expected string."],
		["unschemed", "Its descriptor is invalid at /setup/schema: Expected kind 'BoxSchema'."],
	]);
});

test("a Chat keeps its preset and its Generations once a Box in it is no longer loaded", async () => {
	const database = openObservedDatabase();
	try {
		await loadBoxes([builtInBoxes, installPlugins({ lantern: { fields: 'instructions: "The lantern is lit.", alwaysRender: true' } })]);
		const conversation = createChat(database);
		insertBox(database, conversation.id, "lantern");
		await loadBoxes([builtInBoxes]);
		withProfile(database);
		const app = createConversationRoutes(database, { masterKey: key, fetch: captureModelFetch(() => {}) });
		const preset = await readPreset(app, conversation.id);
		const block = preset.slots.find(({ reference }) => reference === "box:lantern");
		if (block === undefined) throw new Error("The preset lost the Lantern's block.");
		expect((await duplicateBlock(database, preset.id, block.id)).status).toBe(422);
		const generationId = await startGeneration(app, conversation.id, (await readConversation(app, conversation.id)).revision);
		expect((await readInspection(app, conversation.id, generationId)).promptPlan.blocks.map(({ content }) => content)).not.toContain("The lantern is lit.");
	} finally {
		database.close();
		await loadBoxes([builtInBoxes]);
	}
});
