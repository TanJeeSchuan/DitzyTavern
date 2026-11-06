import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { boxDescriptor, boxRecordSchema } from "../../shared/contract/box";
import { createConnectionSettingsModule } from "../connection-settings";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { key, profile } from "../contract/prompt-preset-test-fixtures";
import { createConversationWithHistory, insertBox, openObservedDatabase, setBoxState } from "../test-fixtures/conversation";
import { DELEGATE_PROMPT_BYTES, DELEGATE_STEPS } from "./delegate";
import { applyBoxDelegateSettings, readBoxDelegateSettings } from "./delegate-settings";
import { prepareBoxDigests, queueBoxDigest, readBoxCatchUp, readDelegate, startBoxCatchUp, startBoxDigests } from "./digest";
import { createBoxWindowRoutes } from "../contract/box-window";
import { readRecordSlots, writeAutomaticRecord } from "./records";
import { builtInBoxes, loadBoxes } from "./registry";

// @approved
//  The delegate's model, a localhost fake speaking Chat Completions: each
// request takes the next scripted reply, a call to `apply` with its
// arguments or plain text, and a reply may be held until the test releases
// it. Each request's body is kept, so a test reads the prompt it carried.
type Reply = { readonly apply: unknown } | { readonly text: string } | { readonly held: Promise<void>; readonly then: Reply };
const replies: Reply[] = [];
const bodies: { readonly messages: readonly { readonly role: string; readonly content: unknown }[] }[] = [];
type Delta = { readonly role?: "assistant"; readonly content?: string; readonly tool_calls?: readonly { readonly index: number; readonly id: string; readonly type: "function"; readonly function: { readonly name: string; readonly arguments: string } }[] };
const chunk = (delta: Delta, finish: string | null) => `data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "stage-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const answer = async (reply: Reply | undefined): Promise<Response> => {
	if (reply === undefined) return new Response("No reply scripted.", { status: 500 });
	if ("held" in reply) {
		await reply.held;
		return await answer(reply.then);
	}
	const chunks = "text" in reply ? [chunk({ role: "assistant", content: reply.text }, null), chunk({}, "stop")]
		: [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${bodies.length}`, type: "function", function: { name: "apply", arguments: JSON.stringify(reply.apply) } }] }, null), chunk({}, "tool_calls")];
	return new Response(`${chunks.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
};
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
	bodies.push(await request.json());
	return await answer(replies.shift());
} });
/** @approved One successful delegate run: the batch, then the text that ends the turn. */
const applies = (...operations: { readonly kind: string; readonly prop: string }[]): Reply[] => [{ apply: { operations } }, { text: "Done." }];
const promptOf = (index: number) => JSON.stringify(bodies[index]?.messages.at(-1)?.content);

const scratch = join(import.meta.dir, "../../../.scratch");
let plugins: string;
beforeAll(async () => {
	mkdirSync(scratch, { recursive: true });
	plugins = mkdtempSync(join(scratch, "delegate-job-"));
	cpSync(join(import.meta.dir, "../../../e2e/fixtures/boxes/scene"), join(plugins, "scene"), { recursive: true });
	await loadBoxes([builtInBoxes, plugins]);
});
afterAll(async () => {
	await server.stop(true);
	rmSync(plugins, { recursive: true, force: true });
	await loadBoxes([builtInBoxes]);
});

let database: Database;
let stop: (() => Promise<void>) | undefined;
beforeEach(() => {
	initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
	database = openObservedDatabase();
	replies.length = 0;
	bodies.length = 0;
});
afterEach(async () => {
	await stop?.();
	stop = undefined;
	database.close();
});

const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
/** @approved A Chat holding the Scene, with the delegate set to the fake model at `requestUrl`, and the queue running. */
const sceneChat = (requestUrl = `http://127.0.0.1:${server.port}/v1/`) => {
	const chat = createConversationWithHistory(database, {
		name: "Stage", participants: [{ definition: { name: "Writer", prompt, openings: [] } }, { definition: { name: "Maren", prompt, openings: [] } }], control: { human: 0, model: 1 },
	});
	setBoxState(database, chat.id, "memory", "absent");
	const instance = insertBox(database, chat.id, "scene");
	const connections = createConnectionSettingsModule(database, { masterKey: key });
	const profileId = connections.createProfile({ expectedRevision: connections.get().revision, profile: { ...profile, displayName: "Stage", requestUrl }, credential: "stage-secret" })
		.profiles.find(({ displayName }) => displayName === "Stage")!.id; // @approved The profile was just created.
	applyBoxDelegateSettings(database, "scene", { type: "apply", expectedRevision: readBoxDelegateSettings(database, "scene").revision, profileId, model: "stage-1" });
	stop = startBoxDigests(database);
	const slot = (variantId: number) => readRecordSlots(drizzle(database), "scene", boxRecordSchema(boxDescriptor("scene")), instance, [variantId]).get(variantId);
	return { chat, instance, slot };
};

const addPassage = (conversationId: number, position: number, content: string): number => {
	const message = database.query<{ id: number }, [number, number]>("INSERT INTO messages (conversation_id, position, timestamp) VALUES (?, ?, '2026-01-01') RETURNING id").get(conversationId, position)!; // @approved RETURNING answers the inserted row.
	return database.query<{ id: number }, [number, string]>("INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 0, ?, '2026-01-01', 1) RETURNING id").get(message.id, content)!.id; // @approved RETURNING answers the inserted row.
};
const edit = (variantId: number, content: string) => database.query("UPDATE message_variant SET content = ? WHERE id = ?").run(content, variantId);
const touch = (conversationId: number, ...variantIds: number[]) => prepareBoxDigests(database, { conversationId, touchedVariantIds: variantIds, removedVariantIds: [] })();
const settled = async (condition: () => boolean) => {
	for (let attempt = 0; attempt < 2000 && !condition(); attempt += 1) await Bun.sleep(2);
	if (!condition()) throw new Error("The condition never became true.");
};

test("a tagged passage runs its delegate once and lands its record; an untagged one gets no job", async () => {
	const { chat, slot } = sceneChat();
	const quiet = addPassage(chat.id, 1, "The hall is quiet.");
	const tagged = addPassage(chat.id, 2, "Maren waits. <scene>put the lantern on the table</scene>");
	replies.push(...applies({ kind: "place", prop: "lantern" }));
	touch(chat.id, quiet, tagged);
	await settled(() => slot(tagged)?.automatic !== undefined);
	expect(slot(tagged)?.automatic).toEqual({ props: ["lantern"] });
	expect(slot(quiet)).toBeUndefined();
	expect(bodies).toHaveLength(2);
	expect(promptOf(0)).toContain("put the lantern on the table");
	touch(chat.id, tagged);
	await Bun.sleep(50);
	expect(bodies).toHaveLength(2);
});

test("two tagged passages run in order, the second seeing the first's record", async () => {
	const { chat, slot } = sceneChat();
	const first = addPassage(chat.id, 1, "<scene>light the lantern</scene>");
	const second = addPassage(chat.id, 2, "<scene>set the table</scene>");
	const release = Promise.withResolvers<void>();
	replies.push({ held: release.promise, then: { apply: { operations: [{ kind: "place", prop: "lantern" }] } } }, { text: "Done." }, ...applies({ kind: "place", prop: "table" }));
	touch(chat.id, second, first);
	await settled(() => bodies.length === 1);
	await Bun.sleep(30);
	expect(bodies).toHaveLength(1);
	expect(promptOf(0)).toContain("light the lantern");
	release.resolve();
	await settled(() => slot(second)?.automatic !== undefined);
	expect(promptOf(2)).toContain(JSON.stringify(JSON.stringify(["lantern"])).slice(1, -1));
	expect(slot(second)?.automatic).toEqual({ props: ["lantern", "table"] });
});

test("an edit runs the passage again on the state before it, never its own record, and leaves a later passage alone; a retry runs only the failed passage", async () => {
	const { chat, slot } = sceneChat();
	const first = addPassage(chat.id, 1, "<scene>light the lantern</scene>");
	const second = addPassage(chat.id, 2, "<scene>set the table</scene>");
	replies.push(...applies({ kind: "place", prop: "lantern" }), ...applies({ kind: "place", prop: "table" }));
	touch(chat.id, first, second);
	await settled(() => slot(second)?.automatic !== undefined);
	edit(first, "<scene>light the lantern again</scene>");
	replies.push(...applies({ kind: "place", prop: "lantern" }));
	touch(chat.id, first);
	await settled(() => bodies.length === 6 && slot(first)?.error === undefined && slot(first)?.automatic !== undefined && slot(first)?.source !== slot(second)?.source);
	await Bun.sleep(30);
	expect(promptOf(4)).toContain("State before the passage, as JSON:\\n[]");
	expect(slot(first)?.automatic).toEqual({ props: ["lantern"] });
	expect(bodies).toHaveLength(6);

	edit(first, "<scene>light the lantern once more</scene>");
	replies.push({ text: "I will not." });
	touch(chat.id, first);
	await settled(() => slot(first)?.error !== undefined);
	replies.push(...applies({ kind: "place", prop: "lantern" }));
	queueBoxDigest(database, chat.id, "scene", { variantId: first });
	await settled(() => slot(first)?.error === undefined);
	await Bun.sleep(30);
	expect(bodies).toHaveLength(9);
	expect(slot(second)?.automatic).toEqual({ props: ["lantern", "table"] });
});

const failure = async (scripted: readonly Reply[], content = "<scene>put the lantern on the table</scene>") => {
	const { chat, slot } = sceneChat();
	const passage = addPassage(chat.id, 1, content);
	replies.push(...scripted);
	touch(chat.id, passage);
	await settled(() => slot(passage)?.error !== undefined);
	expect(slot(passage)?.automatic).toBeUndefined();
	return slot(passage)?.error?.message;
};

test("a batch outside the operations goes back to the model, and an agent that never sends a valid one fails with the batch's reason", async () => {
	expect(await failure([{ apply: { operations: [{ kind: "burn", prop: "lantern" }] } }, { text: "Done." }])).toBe("The delegate's batch is invalid at /operations/0: Expected union value.");
});

test("a second apply fails the run", async () => {
	expect(await failure([{ apply: { operations: [] } }, { apply: { operations: [] } }])).toBe("The delegate called apply a second time.");
});

test("an agent that ends without apply fails the run", async () => {
	expect(await failure([{ text: "The lantern is lovely." }])).toBe("The delegate ended without calling apply.");
});

test(`model requests and tool calls past ${DELEGATE_STEPS} steps fail the run`, async () => {
	expect(await failure(Array.from({ length: 10 }, () => ({ apply: { operations: [{ kind: "burn", prop: "lantern" }] } })))).toBe(`The delegate passed its ${DELEGATE_STEPS}-step limit.`);
	expect(bodies).toHaveLength(5);
});

test("state over the prompt limit fails the run before any request, rather than cut short", async () => {
	const { chat, instance, slot } = sceneChat();
	const before = addPassage(chat.id, 1, "The props arrive.");
	const props = Array.from({ length: 20 }, (_, index) => `${"prop".repeat(9)}${index}`);
	writeAutomaticRecord(drizzle(database), boxDescriptor("scene"), instance, before, { props }, "source");
	const passage = addPassage(chat.id, 2, `<scene>${"move them all. ".repeat(DELEGATE_PROMPT_BYTES / 15)}</scene>`);
	touch(chat.id, passage);
	await settled(() => slot(passage)?.error !== undefined);
	expect(slot(passage)?.error?.message).toBe("The delegate's prompt is over its 64 KiB limit, and its state is not cut short to fit.");
	expect(bodies).toHaveLength(0);
});

test("a reducer that throws fails the run with its message", async () => {
	expect(await failure(applies({ kind: "remove", prop: "lantern" }))).toBe("The scene Box's delegate.apply threw Error: There is no lantern on stage.");
});

test("an edit while the delegate runs drops its result, and the new text runs instead", async () => {
	const { chat, slot } = sceneChat();
	const passage = addPassage(chat.id, 1, "<scene>light the lantern</scene>");
	const release = Promise.withResolvers<void>();
	replies.push({ held: release.promise, then: { apply: { operations: [{ kind: "place", prop: "lantern" }] } } });
	touch(chat.id, passage);
	await settled(() => bodies.length === 1);
	edit(passage, "<scene>set the table</scene>");
	replies.push(...applies({ kind: "place", prop: "table" }));
	touch(chat.id, passage);
	await settled(() => slot(passage)?.automatic !== undefined);
	release.resolve();
	await Bun.sleep(50);
	expect(slot(passage)?.automatic).toEqual({ props: ["table"] });
});

test("without a delegate setting nothing runs; a broken one fails each run with its reason, which the notice read shows", async () => {
	const { chat, slot } = sceneChat("http://192.168.1.4:8080/v1/");
	const passage = addPassage(chat.id, 1, "<scene>light the lantern</scene>");
	touch(chat.id, passage);
	await settled(() => slot(passage)?.error !== undefined);
	const reason = "Stage uses HTTP; an agent sends HTTP only to localhost, so use HTTPS.";
	expect(readDelegate(database, chat.id, "scene")).toEqual({ setting: { kind: "broken", reason }, failed: { messageId: expect.any(Number), variantId: passage, number: 1, error: reason } });

	applyBoxDelegateSettings(database, "scene", { type: "apply", expectedRevision: readBoxDelegateSettings(database, "scene").revision, profileId: null, model: "" });
	const later = addPassage(chat.id, 2, "<scene>set the table</scene>");
	touch(chat.id, later);
	startBoxCatchUp(database, chat.id, "scene");
	await Bun.sleep(50);
	expect(slot(later)).toBeUndefined();
	expect(bodies).toHaveLength(0);
	expect(readDelegate(database, chat.id, "scene")?.setting).toEqual({ kind: "off" });
});

test("catch-up queues only tagged passages without a record, and the retry route answers with the notice read", async () => {
	const { chat, slot } = sceneChat();
	addPassage(chat.id, 1, "The hall is quiet.");
	const first = addPassage(chat.id, 2, "<scene>light the lantern</scene>");
	const second = addPassage(chat.id, 3, "<scene>set the table</scene>");
	replies.push(...applies({ kind: "place", prop: "lantern" }), ...applies({ kind: "place", prop: "table" }));
	startBoxCatchUp(database, chat.id, "scene");
	expect(readBoxCatchUp(database, chat.id, "scene")).toEqual({ total: 2, remaining: 2, failed: 0 });
	await settled(() => slot(second)?.automatic !== undefined);
	expect(slot(first)?.automatic).toEqual({ props: ["lantern"] });
	const retried = await createBoxWindowRoutes(database).handle(new Request(`http://localhost/api/conversations/${chat.id}/boxes/scene/digest`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ variantId: first }),
	}));
	expect(await retried.json()).toEqual({ setting: { kind: "ready" }, failed: null });
	await Bun.sleep(30);
	expect(bodies).toHaveLength(4);
});
