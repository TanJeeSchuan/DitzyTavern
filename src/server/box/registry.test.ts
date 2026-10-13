import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { boxDescriptors } from "../../shared/contract/box";
import { boxSdkVersion } from "../../shared/contract/box-descriptor";
import { createBoxRoutes } from "../contract/boxes";
import { createConversationRoutes } from "../contract/conversation";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { configureDecisionModels } from "../contract/decision-model-test-fixtures";
import { captureModelFetch, completeGeneration, createChat, duplicateBlock, key, readConversation, readInspection, readPreset, startGeneration, withProfile } from "../contract/prompt-preset-test-fixtures";
import { insertBox, openObservedDatabase, setBoxState } from "../test-fixtures/conversation";
import { applyBoxDecisionSettings, readBoxDecisionSettings } from "./decision-settings";
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

test("a Box's Decision Model selection is part of its preview fingerprint, and its credential is not", () => {
	const database = openObservedDatabase();
	try {
		initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
		const selection = configureDecisionModels(database, key, "model-a");
		const human = { id: 1, name: "Ann" };
		const capture = () => fingerprintBoxes(captureBoxes(
			[{ reference: "box:mood", enabled: true, role: "system", content: "" }],
			{},
			{ "author-note": "absent", memory: "absent", mood: "enabled", phone: "absent", race: "absent", thought: "absent", "world-clock": "absent" },
			{},
			{},
			{ database, conversationId: 1, seed: "seed", intent: "respond", human, cast: [human], messages: [], pending: undefined },
		));
		const before = capture();
		applyBoxDecisionSettings(database, "mood", { type: "apply", expectedRevision: readBoxDecisionSettings(database, "mood").revision, ...selection, decisionModel: "model-b" });
		expect(capture()).not.toBe(before);
		expect(before).not.toContain("decision-secret");
	} finally {
		database.close();
	}
});

const lantern = { sdk: boxSdkVersion, label: "Lantern", role: "system", startsEnabled: false, instructions: "" };
const pluginFolders: string[] = [];
afterEach(() => { for (const folder of pluginFolders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
// @approved
//  Each plugin's descriptor is the Lantern's under its folder's name, with
// `fields`, as source, written over it. A plugin outside the checkout reaches
// the host's Elysia by its resolved path, as an installed one does by name.
const elysia = `import { Elysia } from ${JSON.stringify(Bun.resolveSync("elysia", import.meta.dir))};`;
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
		unrouted: { server: 'export default { routes: () => { throw new Error("The hook is bent."); } };' },
		unmounted: { server: `${elysia} export default { routes: () => Object.defineProperty(new Elysia(), "router", { get() { throw new Error("The hook will not hang."); } }) };` },
		"hollow-moves": { server: "export default { moves: {} };" },
		"hollow-records": { server: "export default { records: { initial: 0 } };" },
		"hollow-advance": { server: 'export default { advance: { run: "soon" } };' },
		"hollow-routes": { server: "export default { routes: () => ({}) };" },
	});
	const database = openObservedDatabase();
	const { boxes, refused } = await discoverBoxes([builtInBoxes, plugins], database).finally(() => database.close());
	expect(boxes.map(({ descriptor }) => descriptor.id)).toEqual([...boxDescriptors().keys(), "lantern"]);
	expect(refused.map(({ folder, reason }) => [basename(folder), reason])).toEqual([
		["bad-initial", "Its initial setup does not match its setup schema."],
		["broken", "The wick is wet."],
		["hollow-advance", "Its server module is invalid at /advance/run: Expected function."],
		["hollow-moves", "Its server module is invalid at /moves/render: Expected required property."],
		["hollow-records", "Its server module is invalid at /records/fold: Expected required property."],
		["hollow-routes", "The hollow-routes Box's routes must return an Elysia app."],
		["mood", "A Box with the id mood is already loaded."],
		["old-sdk", `It was built for Box SDK ${boxSdkVersion - 1}; this host runs ${boxSdkVersion}.`],
		["renamed", "Its folder must be named for its id, lantern."],
		["unhooked", "The unhooked Box must declare a digest exactly when it declares a decision."],
		["unlabelled", "Its descriptor is invalid at /label: Expected string."],
		["unmounted", "The hook will not hang."],
		["unrouted", "The hook is bent."],
		["unschemed", "Its descriptor is invalid at /setup/schema: Expected kind 'BoxSchema'."],
	]);
});

test("a disabled Box's records are not folded, so turning off a Box whose fold throws lets the Chat generate", async () => {
	const database = openObservedDatabase();
	try {
		await loadBoxes([builtInBoxes, installPlugins({ lantern: {
			fields: 'record: { [Symbol.for("TypeBox.Kind")]: "Object", type: "object", properties: {} }',
			server: 'export default { records: { initial: 0, fold: () => { throw new Error("The wick is wet."); } }, advance: { run: async () => ({ items: [], record: {} }) } };',
		} })]);
		const conversation = createChat(database);
		insertBox(database, conversation.id, "lantern");
		withProfile(database);
		const app = createConversationRoutes(database, { masterKey: key, fetch: captureModelFetch(() => {}) });
		const send = async () => app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "send", expectedRevision: (await readConversation(app, conversation.id)).revision, content: "Light it." }),
		}));
		await completeGeneration(app, conversation.id, (await (await send()).json()).generationId);
		expect((await send()).status).toBe(500);
		setBoxState(database, conversation.id, "lantern", "disabled");
		expect((await send()).status).toBe(200);
	} finally {
		database.close();
		await loadBoxes([builtInBoxes]);
	}
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

test("a plugin's routes are served as the loader built them, its client module and stylesheet from its dist folder, and nothing else in it", async () => {
	const plugins = installPlugins({ lantern: {
		server: `${elysia} let built = false; export default { routes: () => { if (built) throw new Error("Built twice."); built = true; return new Elysia().get("/lit", () => "The lantern is lit."); } };`,
	} });
	mkdirSync(join(plugins, "lantern", "dist"));
	writeFileSync(join(plugins, "lantern", "dist", "client.js"), "export default {};");
	const database = openObservedDatabase();
	try {
		await loadBoxes([builtInBoxes, plugins], database);
		const app = createBoxRoutes();
		const served = async (path: string) => {
			const response = await app.handle(new Request(`http://localhost${path}`));
			return [response.status, response.status === 200 ? await response.text() : ""];
		};
		expect(await served("/api/boxes/lantern/lit")).toEqual([200, "The lantern is lit."]);
		expect(await served("/boxes/lantern/client.js")).toEqual([200, "export default {};"]);
		expect(await served("/boxes/lantern/client.css")).toEqual([404, ""]);
		expect(await served("/boxes/lantern/server.ts")).toEqual([404, ""]);
		expect(await served("/boxes/unloaded/client.js")).toEqual([404, ""]);
	} finally {
		database.close();
		await loadBoxes([builtInBoxes]);
	}
});
