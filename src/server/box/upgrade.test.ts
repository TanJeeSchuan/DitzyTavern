import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { acceptConversationTailGeneration, executeConversationCommand, forkConversation, readConversationSummary } from "../conversation";
import type { ConversationAction } from "../conversation";
import { createConversationWithHistory, checkpointFromStart, openObservedDatabase, setBoxState } from "../test-fixtures/conversation";
import { writeVersionedBox, type BoxFiles } from "../test-fixtures/versioned-box";
import { recoverActiveGenerations } from "../workflows/generation-recovery";
import { boxAt, builtInBoxes, chatBox, checkSandboxedFolder, installVersion, loadBoxes, loadBoxVersion, unversionedBoxIds } from "./registry";
import { readBoxLifecycles } from "./setup";
import { versionFolder, writeLatest } from "./versions";
import { captureModelFetch, key, readConversation, withProfile } from "../contract/prompt-preset-test-fixtures";
import { createConversationRoutes } from "../contract/conversation";
import { initializeConnectionSecretKey } from "../connection-secrets";

const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
const integer = { type: "integer" };
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const v1 = {
	setup: { schema: object({ goal: { type: "integer", minimum: 1 } }), initial: { goal: 3 } },
	values: { chat: { host: { type: "integer", rowReference: "participant" } }, participant: { odds: { type: "object", patternProperties: { "^(?:[0-9])+$": integer } } } },
	record: object({ coins: { type: "integer", minimum: 0 } }),
	moves: { schema: object({ coins: { type: "integer", minimum: 1 } }), max: 3, label: "Tip {coins}" },
};
const hooks = {
	moves: "moves: { render: ({ coins }, author) => author + \" tips \" + coins + \".\" },",
	records: "records: { initial: 0, fold: (total, { coins }) => total + coins },",
	advance: "advance: { run: async ({ state }) => ({ items: [{ text: \"The jar holds \" + state + \".\", priority: 0, pinned: true }], record: { coins: 1 } }) },",
};
/** @approved The Tally Box at one version: v1's descriptor with `fields` replaced, and its hooks with `logic` replaced. */
const tally = (fields: Record<string, unknown> = {}, logic: Partial<Record<keyof typeof hooks | "extra", string>> = {}): BoxFiles => ({
	"descriptor.json": JSON.stringify({ id: "tally", sdk: 2, label: "Tally", summary: "Counts tips.", role: "system", startsEnabled: false, instructions: "", window: { icon: "coins", size: { width: 10, height: 10 } }, ...v1, ...fields }),
	"logic.js": `export default { ${Object.values({ ...hooks, ...logic }).join(" ")} };`,
	"ui.js": "host.render('');",
});
/** @approved v1 under another hash: the same behaviour, so only the version tells them apart. */
const same = tally({}, { extra: "/* v2 */" });

let database: Database;
let removes: (() => void)[] = [];
beforeEach(() => { database = openObservedDatabase(); });
afterEach(async () => {
	database.close();
	await loadBoxes([builtInBoxes]);
	for (const remove of removes.splice(0)) remove();
});

/** @approved Loads the Tally Box with `latest` at v1 and `other` beside it, both versions loaded. */
const versioned = async (other: BoxFiles) => {
	const box = await writeVersionedBox("tally", [tally(), other]);
	removes.push(box.remove);
	await loadBoxes([builtInBoxes, box.plugins]);
	await loadBoxVersion("tally", box.versions[1]!); // @approved Two versions were written.
	return { ...box, v1: box.versions[0]!, v2: box.versions[1]! }; // @approved Two versions were written.
};
const createChat = () => createConversationWithHistory(database, {
	name: "Tip Chat", participants: [{ definition: { name: "Writer", prompt, openings: [] } }, { definition: { name: "Maren", prompt, openings: ["The jar waits."] } }], control: { human: 0, model: 1 },
});
const command = (conversationId: number, action: ConversationAction) =>
	executeConversationCommand(database, { conversationId, expectedRevision: readConversationSummary(database, conversationId)!.revision, action }); // @approved Every Chat here exists.
const instanceOf = (conversationId: number) => readBoxLifecycles(drizzle(database), conversationId).tally!.instance; // @approved Each test inserts the Tally first.
const rows = (conversationId: number) => ({
	revision: readConversationSummary(database, conversationId)?.revision,
	chat: database.query("SELECT namespace, key, value, revision FROM conversation_data WHERE conversation_id = ? ORDER BY id").all(conversationId),
	messages: database.query("SELECT message_id, namespace, key, value FROM messages_data ORDER BY id").all(),
	variants: database.query("SELECT message_variant_id, namespace, key, value FROM message_variant_data ORDER BY id").all(),
	participants: database.query("SELECT participant_id, namespace, key, value FROM participant_data ORDER BY id").all(),
});
/** @approved A Chat holding the Tally at v1, with a selected record on its opening, and a second, unselected Variant there. */
const tippedChat = () => {
	const chat = createChat();
	setBoxState(database, chat.id, "tally", "enabled");
	const message = chat.messages[0]!; // @approved The model's opening is the first Message.
	const selected = message.variants[0]!.id; // @approved The opening has one Variant.
	const unselected = database.query<{ id: number }, [number]>("INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 2, 'A second jar.', '2026-01-01', 0) RETURNING id").get(message.id)!.id;
	const slot = (variant: number, value: unknown) => database.query("INSERT INTO message_variant_data (message_variant_id, namespace, key, value) VALUES (?, 'box:tally', ?, ?)").run(variant, `record:${instanceOf(chat.id)}`, JSON.stringify(value));
	slot(selected, { automatic: { coins: 2 } });
	return { chat, message, selected, unselected, slot };
};
const upgrade = (conversationId: number, version: string) => command(conversationId, { type: "upgrade-box", box: "tally", version });

test("the pin is written on first insertion, kept on removal, used on reinsertion and copied by Fork", async () => {
	const box = await versioned(same);
	const chat = createChat();
	setBoxState(database, chat.id, "tally", "enabled");
	expect(readConversationSummary(database, chat.id)?.boxVersions).toEqual({ tally: box.v1 });
	await writeLatest(box.home, box.v2);
	installVersion("tally", box.home, box.v2, await checkSandboxedFolder(versionFolder(box.home, box.v2), "tally", unversionedBoxIds()));
	setBoxState(database, chat.id, "tally", "absent");
	expect(readConversationSummary(database, chat.id)?.boxVersions).toEqual({ tally: box.v1 });
	setBoxState(database, chat.id, "tally", "enabled");
	expect([readConversationSummary(database, chat.id)?.boxVersions, chatBox(drizzle(database), chat.id, "tally")?.version]).toEqual([{ tally: box.v1 }, box.v1]);
	const fresh = createChat();
	setBoxState(database, fresh.id, "tally", "enabled");
	expect(readConversationSummary(database, fresh.id)?.boxVersions).toEqual({ tally: box.v2 });
	const summary = readConversationSummary(database, chat.id)!; // @approved Created above.
	const fork = forkConversation(database, { conversationId: chat.id, expectedRevision: summary.revision, at: { through: chat.messages[0]!.id }, name: "Fork", trimVariants: false }); // @approved The opening exists.
	expect(fork.conversation.boxVersions).toEqual({ tally: box.v1 });
});

test("a passing upgrade writes only the pin and advances the revision, keeping the instance so the records still fold", async () => {
	const box = await versioned(same);
	const { chat } = tippedChat();
	const before = rows(chat.id);
	upgrade(chat.id, box.v2);
	const after = rows(chat.id);
	const pinOf = (state: typeof before) => state.chat.map((row) => (row as { namespace: string }).namespace === "box-version" ? { ...row as object, value: "pin" } : row);
	expect({ ...after, revision: undefined, chat: pinOf(after) }).toEqual({ ...before, revision: undefined, chat: pinOf(before) });
	expect([after.revision, readConversationSummary(database, chat.id)?.boxVersions.tally]).toEqual([before.revision! + 1, box.v2]); // @approved The Chat exists.
	expect(boxAt("tally", box.v2)?.box.records?.foldAll?.(0, [{ coins: 2 }], undefined)).toBe(2);
});

// @approved
//  One refusal per rule of the upgrade check: each names its failing place
// and leaves every row as it was.
test.each([
	["a writer record on an unselected Variant that the new record schema refuses", tally({ record: object({ coins: { type: "integer", minimum: 0, maximum: 5 } }) }),
		({ unselected, slot }: ReturnType<typeof tippedChat>) => { slot(unselected, { writer: { coins: 9 } }); return `Variant ${unselected} writer record`; }],
	["a Move list over the new max", tally({ moves: { ...v1.moves, max: 1 } }),
		({ chat }: ReturnType<typeof tippedChat>) => {
			const human = database.query<{ id: number }, [number]>("INSERT INTO messages (conversation_id, position, timestamp, author_participant_id) VALUES (?, 5, '2026-01-01', ?) RETURNING id").get(chat.id, chat.cast[0]!.id)!.id; // @approved The Chat has its Writer.
			database.query("INSERT INTO messages_data (message_id, namespace, key, value) VALUES (?, 'box:tally', 'moves', ?)").run(human, JSON.stringify([{ coins: 1 }, { coins: 2 }]));
			return `Message ${human} Moves`;
		}],
	["a version that drops record while records exist", tally({ record: undefined }, { records: "", advance: hooks.advance.replace(", record: { coins: 1 }", "") }),
		() => "The Chat holds 1 record slots, and this version declares no record."],
	["a setupError that refuses the stored setup", tally({}, { extra: "setupError: ({ goal }) => goal > 5 ? \"That goal is out of reach.\" : undefined," }),
		({ chat }: ReturnType<typeof tippedChat>) => { command(chat.id, { type: "set-box-setup", box: "tally", setup: { goal: 9 } }); return "Setup: That goal is out of reach."; }],
	["a changed rowReference", tally({ values: { ...v1.values, chat: { host: integer } } }),
		() => "Row reference at chat value host (participant): this version no longer has it, so Fork would stop remapping it"],
	["a ParticipantKey Record turned into a string-keyed one, which accepts the same values", tally({ values: { ...v1.values, participant: { odds: { type: "object", patternProperties: { "^(.*)$": integer } } } } }),
		({ chat }: ReturnType<typeof tippedChat>) => {
			command(chat.id, { type: "commit-box", box: "tally", version: readConversationSummary(database, chat.id)!.boxVersions.tally, writes: [{ owner: { type: "participant", participantId: chat.cast[1]!.id }, key: "odds", value: JSON.stringify({ [chat.cast[0]!.id]: 2 }) }] }); // @approved The Chat and its Cast exist.
			return "Row reference at participant value odds/{key} (participant key): this version no longer has it, so Fork would stop remapping it";
		}],
] as const)("an upgrade over %s is refused and changes nothing", async (_, other, arrange) => {
	const box = await versioned(other);
	const tipped = tippedChat();
	const place = arrange(tipped);
	const before = rows(tipped.chat.id);
	expect(() => upgrade(tipped.chat.id, box.v2)).toThrow(place);
	expect(rows(tipped.chat.id)).toEqual(before);
	expect(readConversationSummary(database, tipped.chat.id)?.boxVersions.tally).toBe(box.v1);
});

test("an old window's commit is refused after an upgrade, even at the current revision", async () => {
	const box = await versioned(same);
	const { chat } = tippedChat();
	upgrade(chat.id, box.v2);
	const write = { owner: { type: "participant" as const, participantId: chat.cast[1]!.id }, key: "odds", value: "{}" }; // @approved The Chat has its Cast.
	expect(() => command(chat.id, { type: "commit-box", box: "tally", version: box.v1, writes: [write] })).toThrow("runs a version this Chat no longer uses");
	expect(() => command(chat.id, { type: "commit-box", box: "tally", version: box.v2, writes: [write] })).not.toThrow();
});

// @approved
//  The control run, with no upgrade, lands the same record, so only the
// version comparison drops it.
for (const upgraded of [false, true]) {
	test(`a Generation that captured v1 ${upgraded ? "completes its prose but not its v1 record once the Chat is on v2" : "writes its record while the Chat stays on v1"}`, async () => {
		const box = await versioned(same);
		const chat = createChat();
		setBoxState(database, chat.id, "tally", "enabled");
		const [human, model] = readConversationSummary(database, chat.id)!.cast; // @approved Created above.
		const accepted = acceptConversationTailGeneration(database, {
			seed: "seed", conversationId: chat.id, expectedRevision: readConversationSummary(database, chat.id)!.revision, timestamp: "2026-11-05T00:00:00.000Z", // @approved Created above.
			humanContent: "Tip it.", humanParticipantId: human!.id, modelParticipantId: model!.id, capturedModelName: model!.name, // @approved The Chat has both seats.
			promptPlan: { blocks: [], warnings: [], images: [] }, modelId: "fixture-model", promptInspection: { tokenEstimate: 0, responseBudget: 64, safetyAllowance: 0, contextLimit: 128, totalRequiredTokens: 64, omittedContext: [] },
			boxRecords: { tally: { instance: instanceOf(chat.id), version: box.v1, record: { coins: 4 } } },
		});
		if (upgraded) upgrade(chat.id, box.v2);
		checkpointFromStart(database, { conversationId: chat.id, generationId: accepted.generationId, content: "Coins clink." });
		recoverActiveGenerations(database);
		const variant = database.query<{ content: string }, [number]>("SELECT content FROM message_variant WHERE id = ?").get(accepted.provisionalVariantId);
		const record = database.query<{ value: string }, [number]>("SELECT value FROM message_variant_data WHERE message_variant_id = ? AND namespace = 'box:tally'").get(accepted.provisionalVariantId);
		expect([variant?.content, record === null ? null : JSON.parse(record.value)]).toEqual(["Coins clink.", upgraded ? null : { automatic: { coins: 4 } }]);
	});
}

// @approved
//  The control run sends the same unchanged preview, so the version in the
// fingerprint is what makes it stale.
for (const upgraded of [false, true]) {
	test(`a preview made under v1 ${upgraded ? "is stale once the Chat is on v2" : "sends while the Chat stays on v1"}`, async () => {
		const box = await versioned(same);
		initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
		const chat = createChat();
		setBoxState(database, chat.id, "tally", "enabled");
		withProfile(database);
		const app = createConversationRoutes(database, { masterKey: key, fetch: captureModelFetch(() => {}) });
		const post = async (path: string, body: object) => app.handle(new Request(`http://localhost/api/conversations/${chat.id}/generations${path}`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "send", content: "Tip it.", ...body }),
		}));
		const { previewId, promptPlan } = await (await post("/preview", {})).json();
		if (upgraded) upgrade(chat.id, box.v2);
		const response = await post("", { expectedRevision: (await readConversation(app, chat.id)).revision, previewId, promptPlan });
		expect(response.status).toBe(upgraded ? 422 : 200);
		if (upgraded) expect(await response.json()).toMatchObject({ reason: "The Prompt Plan is stale. Refresh it before sending." });
	});
}
