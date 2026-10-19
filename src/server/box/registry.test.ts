import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { boxDescriptors } from "../../shared/contract/box";
import { sha256 } from "../hash";
import { foldRecordStates, writeAutomaticRecord } from "./records";
import { boxSdkVersion } from "../../shared/contract/box-descriptor";
import { createBoxRoutes } from "../contract/boxes";
import { createConversationRoutes } from "../contract/conversation";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { configureDecisionModels } from "../contract/decision-model-test-fixtures";
import { captureModelFetch, completeGeneration, createChat, duplicateBlock, key, readConversation, readInspection, readPreset, startGeneration, withProfile } from "../contract/prompt-preset-test-fixtures";
import { acceptConversationTailGeneration, checkpointConversationGeneration } from "../conversation";
import { insertBox, openObservedDatabase, setBoxState } from "../test-fixtures/conversation";
import { setPromptPresetBlockEnabled } from "../prompt-preset/blocks";
import { recoverActiveGenerations } from "../workflows/generation-recovery";
import { readBoxCatchUp, startBoxCatchUp, startBoxDigests } from "./digest";
import { applyBoxDecisionSettings, readBoxDecisionSettings } from "./decision-settings";
import { advanceBoxes, builtInBoxes, captureBoxes, discoverBoxes, fingerprintBoxes, loadBoxes, participatingBoxes } from "./registry";

test("a Phone contact added after inspection makes the plan stale", () => {
	const human = { id: 1, name: "Ann" };
	const capture = (cast: readonly { id: number; name: string }[]) => fingerprintBoxes(captureBoxes(
		participatingBoxes([{ reference: "box:phone", enabled: true, role: "system", content: "" }], { phone: { state: "enabled", instance: "instance" } }),
		{},
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
			participatingBoxes([{ reference: "box:mood", enabled: true, role: "system", content: "" }], { mood: { state: "enabled", instance: "instance" } }),
			{},
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

const lantern = { sdk: boxSdkVersion, label: "Lantern", summary: "Hangs a lit lantern in the scene.", role: "system", startsEnabled: false, instructions: "" };
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
		constructor: {},
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
		"map-initial": { fields: 'record: { [Symbol.for("TypeBox.Kind")]: "Object", type: "object", properties: {} }', server: "export default { records: { initial: new Map(), fold: (state) => state } };" },
	});
	const database = openObservedDatabase();
	const { boxes, refused } = await discoverBoxes([builtInBoxes, plugins], database).finally(() => database.close());
	expect(boxes.map(({ descriptor }) => descriptor.id)).toEqual([...boxDescriptors().keys(), "lantern"]);
	expect(refused.map(({ folder, reason }) => [basename(folder), reason])).toEqual([
		["bad-initial", "Its initial setup does not match its setup schema."],
		["broken", "The wick is wet."],
		["constructor", "Its id, constructor, names an Object.prototype property."],
		["hollow-advance", "Its server module is invalid at /advance/run: Expected function."],
		["hollow-moves", "Its server module is invalid at /moves/render: Expected required property."],
		["hollow-records", "Its server module is invalid at /records/fold: Expected required property."],
		["hollow-routes", "The hollow-routes Box's routes must return an Elysia app."],
		["map-initial", "The map-initial Box's state must be JSON or undefined."],
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

for (const disabledBy of ["chat", "preset"] as const) test(`a Box disabled by its ${disabledBy} neither folds nor decodes records during generation`, async () => {
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
		if (disabledBy === "chat") setBoxState(database, conversation.id, "lantern", "disabled");
		else {
			const preset = await readPreset(app, conversation.id);
			setPromptPresetBlockEnabled(database, preset.id, preset.slots.find(({ reference }) => reference === "box:lantern")!.id, false);
		}
		const accepted = await send();
		expect(accepted.status).toBe(200);
		await completeGeneration(app, conversation.id, (await accepted.json()).generationId);
		database.query("UPDATE message_variant_data SET value = 'invalid json' WHERE namespace = 'box:lantern'").run();
		expect((await send()).status).toBe(200);
	} finally {
		database.close();
		await loadBoxes([builtInBoxes]);
	}
});

test("an unchanged preview of a Box block whose pinned items exceed its allowance sends, as Generation admits it", async () => {
	const database = openObservedDatabase();
	try {
		await loadBoxes([builtInBoxes, installPlugins({ lantern: {
			server: 'export default { advance: { run: async () => ({ items: [{ text: "The lantern is lit and swinging.", priority: 0, pinned: true }], allowance: 0 }) } };',
		} })]);
		const conversation = createChat(database);
		insertBox(database, conversation.id, "lantern");
		withProfile(database);
		let sent = "";
		const app = createConversationRoutes(database, { masterKey: key, fetch: captureModelFetch((request) => { sent = JSON.stringify(request.messages); }) });
		const post = async (path: string, body: { readonly kind: "send"; readonly content: string; readonly expectedRevision?: number; readonly previewId?: string; readonly promptPlan?: unknown }) => app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations${path}`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
		}));
		const { previewId, promptPlan } = await (await post("/preview", { kind: "send", content: "Light it." })).json();
		const accepted = await post("", { kind: "send", expectedRevision: (await readConversation(app, conversation.id)).revision, content: "Light it.", previewId, promptPlan });
		expect(accepted.status).toBe(200);
		await completeGeneration(app, conversation.id, (await accepted.json()).generationId);
		expect(sent).toContain("The lantern is lit and swinging.");
	} finally {
		database.close();
		await loadBoxes([builtInBoxes]);
	}
});

test("a Generation holding a record of a Box no longer loaded still settles on recovery, keeping the record as captured", async () => {
	const database = openObservedDatabase();
	try {
		await loadBoxes([builtInBoxes, installPlugins({ lantern: {
			fields: 'record: { [Symbol.for("TypeBox.Kind")]: "Object", type: "object", properties: {} }',
			server: "export default { records: { initial: 0, fold: (state) => state } };",
		} })]);
		const conversation = createChat(database);
		const instance = insertBox(database, conversation.id, "lantern");
		const [human, model] = conversation.cast;
		if (human === undefined || model === undefined) throw new Error("Control Participants missing.");
		const accepted = acceptConversationTailGeneration(database, {
			seed: "lantern-seed", conversationId: conversation.id, expectedRevision: conversation.revision, timestamp: "2026-10-14T00:00:00.000Z",
			humanContent: "Light it.", humanParticipantId: human.id, modelParticipantId: model.id, capturedModelName: model.name,
			promptPlan: { blocks: [], warnings: [], images: [] }, promptInspection: { tokenEstimate: 0, omittedContext: [] }, promptContext: [], generationSettings: {}, connection: {},
			boxRecords: { lantern: { instance, record: { lit: true } } },
		});
		checkpointConversationGeneration(database, { conversationId: conversation.id, generationId: accepted.generationId, content: "The wick catches." });
		await loadBoxes([builtInBoxes]);
		expect(recoverActiveGenerations(database)).toMatchObject({ interrupted: 1, failed: 0 });
		const stored = database.query<{ value: string }, [number]>("SELECT value FROM message_variant_data WHERE message_variant_id = ? AND namespace = 'box:lantern'").get(accepted.provisionalVariantId);
		expect(stored === null ? null : JSON.parse(stored.value)).toEqual({ automatic: { lit: true } });
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

test("a non-JSON Box state is refused with the Box's id, and a changed JSON state marks a preview stale", async () => {
	const database = openObservedDatabase();
	try {
		await loadBoxes([builtInBoxes, installPlugins({ lantern: {
			fields: 'record: { [Symbol.for("TypeBox.Kind")]: "Object", type: "object", properties: {} }',
			server: 'export default { records: { initial: null, fold: () => new Map([["lit", true]]) } };',
		} })]);
		const conversation = createChat(database);
		const instance = insertBox(database, conversation.id, "lantern");
		const boxes = participatingBoxes([{ reference: "box:lantern", enabled: true, role: "system", content: "" }], { lantern: { state: "enabled", instance } });
		const message = database.query<{ id: number }, [number]>("INSERT INTO messages (conversation_id, position, timestamp) VALUES (?, 0, '2026-01-01') RETURNING id").get(conversation.id)!;
		const variant = database.query<{ id: number }, [number]>("INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 0, 'Lit it.', '2026-01-01', 1) RETURNING id").get(message.id)!;
		writeAutomaticRecord(drizzle(database), "lantern", instance, variant.id, {}, sha256("Lit it."));
		expect(() => foldRecordStates(drizzle(database), [variant.id], {}, boxes)).toThrow("The lantern Box's state must be JSON or undefined.");
		const read = { database, conversationId: conversation.id, seed: "seed", intent: "respond" as const, human: { id: 1, name: "Ann" }, cast: [], messages: [], pending: undefined };
		expect(fingerprintBoxes(captureBoxes(boxes, {}, { lantern: { lit: 1 } }, {}, read)))
			.not.toBe(fingerprintBoxes(captureBoxes(boxes, {}, { lantern: { lit: 2 } }, {}, read)));
	} finally {
		database.close();
		await loadBoxes([builtInBoxes]);
	}
});

test("reinserting a participating Box makes its inspected Prompt Plan stale", async () => {
	const database = openObservedDatabase();
	try {
		await loadBoxes([builtInBoxes, installPlugins({ lantern: {
			fields: 'record: { [Symbol.for("TypeBox.Kind")]: "Object", type: "object", properties: {} }',
			server: 'export default { records: { initial: null, fold: (state) => state }, advance: { run: async () => ({ items: [], record: {} }) } };',
		} })]);
		const conversation = createChat(database);
		insertBox(database, conversation.id, "lantern");
		withProfile(database);
		const app = createConversationRoutes(database, { masterKey: key, fetch: captureModelFetch(() => {}) });
		const post = async (path: string, body: { readonly kind: "send"; readonly content: string; readonly expectedRevision?: number; readonly previewId?: string; readonly promptPlan?: unknown }) => app.handle(new Request(`http://localhost/api/conversations/${conversation.id}/generations${path}`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
		}));
		const { previewId, promptPlan } = await (await post("/preview", { kind: "send", content: "Light it." })).json();
		setBoxState(database, conversation.id, "lantern", "absent");
		insertBox(database, conversation.id, "lantern");
		const response = await post("", { kind: "send", expectedRevision: (await readConversation(app, conversation.id)).revision, content: "Light it.", previewId, promptPlan });
		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({ reason: "The Prompt Plan is stale. Refresh it before sending." });
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

for (const field of ["record", "trace"] as const) for (const value of ["new Date()", "new Map()", "() => 1", "Infinity", '{ nested: [null, true, 3, "lit", { wick: false }] }']) test(`advance checks ${field} is JSON: ${value}`, async () => {
	const database = openObservedDatabase();
	try {
		await loadBoxes([builtInBoxes, installPlugins({ lantern: {
			fields: 'record: { [Symbol.for("TypeBox.Kind")]: "Object", type: "object", properties: { value: { [Symbol.for("TypeBox.Kind")]: "Any" } }, required: ["value"] }',
			server: `export default { records: { initial: 0, fold: (state) => state }, advance: { run: async () => ({ items: [], ${field}: { value: ${value} } }) } };`,
		} })]);
		const inputs = captureBoxes(participatingBoxes([{ reference: "box:lantern", enabled: true, role: "system", content: "" }], { lantern: { state: "enabled", instance: "instance" } }), {}, {}, {}, {
			database, conversationId: 1, seed: "seed", intent: "respond", human: { id: 1, name: "Ann" }, cast: [], messages: [], pending: undefined,
		});
		const result = advanceBoxes(inputs, () => ({ signal: new AbortController().signal, llm: () => undefined, decide: async () => { throw new Error("No decisions expected."); }, embed: async () => [] }));
		if (value.startsWith("{")) expect((await result)["box:lantern"]?.[field]).toEqual({ value: { nested: [null, true, 3, "lit", { wick: false }] } });
		else await expect(result).rejects.toThrow();
	} finally {
		database.close();
		await loadBoxes([builtInBoxes]);
	}
});

for (const value of ["new Date()", "new Map()", "() => 1", "Infinity", '{ nested: [null, true, 3, "lit", { wick: false }] }']) test(`digest checks records are JSON: ${value}`, async () => {
	const database = openObservedDatabase();
	let stop: (() => Promise<void>) | undefined;
	try {
		await loadBoxes([builtInBoxes, installPlugins({ lantern: {
			fields: 'record: { [Symbol.for("TypeBox.Kind")]: "Object", type: "object", properties: { value: { [Symbol.for("TypeBox.Kind")]: "Any" } }, required: ["value"] }, decision: { summary: "", description: "", off: "", context: "" }',
			server: `export default { records: { initial: 0, fold: (state) => state, digest: { window: 0, run: async () => ({ value: ${value} }) } } };`,
		} })]);
		const chat = createChat(database);
		insertBox(database, chat.id, "lantern");
		initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
		configureDecisionModels(database, key);
		const message = database.query<{ id: number }, [number]>("INSERT INTO messages (conversation_id, position, timestamp) VALUES (?, 0, '2026-01-01') RETURNING id").get(chat.id)!;
		const variant = database.query<{ id: number }, [number]>("INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 0, 'Light it.', '2026-01-01', 1) RETURNING id").get(message.id)!;
		stop = startBoxDigests(database);
		startBoxCatchUp(database, chat.id, "lantern");
		for (let attempt = 0; attempt < 400 && readBoxCatchUp(database, chat.id, "lantern") !== null; attempt += 1) await Bun.sleep(1);
		expect(readBoxCatchUp(database, chat.id, "lantern")).toBeNull();
		const stored = database.query<{ value: string }, [number]>("SELECT value FROM message_variant_data WHERE message_variant_id = ? AND namespace = 'box:lantern'").get(variant.id)!;
		if (value.startsWith("{")) expect(JSON.parse(stored.value).automatic).toEqual({ value: { nested: [null, true, 3, "lit", { wick: false }] } });
		else {
			expect(JSON.parse(stored.value).automatic).toBeUndefined();
			expect(JSON.parse(stored.value).error.message).toBeString();
		}
	} finally {
		await stop?.();
		database.close();
		await loadBoxes([builtInBoxes]);
	}
});
