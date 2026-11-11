import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { boxDescriptor } from "../../shared/contract/box";
import { builtInBoxes, loadBoxes } from "./registry";
import { writeAutomaticRecord } from "./records";
import { sha256 } from "../hash";
import { createConversationRoutes } from "../contract/conversation";
import { captureModelFetch, completeGeneration, createChat, key, withProfile } from "../contract/prompt-preset-test-fixtures";
import { insertBox, openObservedDatabase } from "../test-fixtures/conversation";
import { afterEach, expect, test } from "bun:test";
import { openInitializedDatabase } from "../database/database";
import { createConversationWithHistory } from "../test-fixtures/conversation";
import type { DecisionAnswer } from "../../shared/contract/decision-model";
import type { ConversationAction } from "../conversation";
import type { DigestContext } from "./contract";
import { readConversationSummaryFromConnection, readSelectedHistoryFromConnection, runConversationReadTransaction } from "../conversation";
import type { BoxWindowRead } from "./contract";
import { SANDBOX_JSON_BYTES, sandboxedBox } from "./sandboxed";

const loaded: (() => void)[] = [];
afterEach(() => { for (const dispose of loaded.splice(0)) dispose(); });
const load = async (logic: string) => {
	const { box, dispose } = await sandboxedBox("probe", logic);
	loaded.push(dispose);
	return box;
};

test("a fold that loops forever stops at the deadline with an error naming the Box and hook, and the Box still answers afterwards", async () => {
	const box = await load("export default { records: { initial: 0, fold: (total, { n }) => { if (n < 0) while (true) {} return total + n; } } };");
	const started = performance.now();
	expect(() => box.records?.foldAll?.(0, [{ n: -1 }], undefined)).toThrow("The probe Box's records.fold ran past its 100 ms limit.");
	expect(performance.now() - started).toBeLessThan(1000);
	expect(box.records?.foldAll?.(0, [{ n: 2 }, { n: 3 }], undefined)).toBe(5);
});

test("a runaway allocation stops at the Box's heap limit, and the Box still answers afterwards", async () => {
	const box = await load("export default { records: { initial: 0, fold: (total, { n }) => { const kept = []; while (n < 0) kept.push(new ArrayBuffer(1 << 20)); return total + n; } } };");
	expect(() => box.records?.foldAll?.(0, [{ n: -1 }], undefined)).toThrow("The probe Box's records.fold ran out of its 64 MiB heap.");
	expect(box.records?.foldAll?.(0, [{ n: 2 }], undefined)).toBe(2);
});

test("an oversized payload is refused in either direction before it crosses", async () => {
	const box = await load("export default { records: { initial: 0, fold: (total) => total }, moves: { render: ({ length }) => 'x'.repeat(length) } };");
	expect(() => box.records?.foldAll?.(0, [{ text: "x".repeat(SANDBOX_JSON_BYTES) }], undefined)).toThrow("The probe Box's records.fold input is over the 4 MiB limit.");
	expect(() => box.moves?.render({ length: SANDBOX_JSON_BYTES }, "Ann")).toThrow("The probe Box's moves.render result is over the 4 MiB limit.");
	expect(box.moves?.render({ length: 3 }, "Ann")).toBe("xxx");
});

test("an async advance that loops before it returns is stopped, and one that never settles fails", async () => {
	const input = { setup: undefined, dependencies: undefined, state: undefined, moves: [] };
	const looping = await load("export default { advance: { run: async () => { await null; while (true) {} } } };");
	await expect(looping.advance?.run(input)).rejects.toThrow("The probe Box's advance.run ran past its 100 ms limit.");
	const hanging = await load("export default { advance: { run: () => new Promise(() => {}) } };");
	await expect(hanging.advance?.run(input)).rejects.toThrow("The probe Box's advance.run never settled.");
});

test("logic has no clock and no randomness of its own", async () => {
	const attempt = (code: string) => `(() => { try { return String(${code}); } catch (error) { return error.message; } })()`;
	const escapes = ["new Date()", "new RealDate().getTime()", "new (new Date(0).constructor)()", "(Reflect.construct = (target) => target, new (new Date(0))())"];
	const box = await load(`export default { moves: { render: () => [typeof Math.random, typeof Date.now, ${escapes.map(attempt).join(", ")}, new Date(0).toISOString()] } };`);
	expect(box.moves?.render({}, "Ann")).toEqual([
		"undefined", "undefined", "Sandboxed logic has no clock.", "'RealDate' is not defined", "Sandboxed logic has no clock.", "not a constructor", "1970-01-01T00:00:00.000Z",
	]);
});

test("a guest throw crosses as the host's error, naming the Box and hook", async () => {
	const box = await load("export default { moves: { render: () => { throw new RangeError('no coins'); } } };");
	expect(() => box.moves?.render({}, "Ann")).toThrow("The probe Box's moves.render threw RangeError: no coins");
});

test("logic.js may declare only the hooks a sandboxed Box supports", async () => {
	await expect(load("export default { routes: () => null };")).rejects.toThrow("The probe Box's logic.js declares routes, which a sandboxed Box cannot.");
	await expect(load("export default { read: 1 };")).rejects.toThrow("The probe Box's logic.js declares read, which must be functions.");
});

// @approved
//  `read` reads its own stored values through `snapshot`, bound to its Chat,
// and the context it ran in is gone once it returns, so a guest that keeps
// `snapshot` in a global has nothing for a later call.
test("a read's snapshot reads only the Box's own values, takes no other query, and no later call can keep it", async () => {
	const database = openInitializedDatabase({ path: ":memory:" });
	const definition = (name: string) => ({ name, prompt: { systemInstruction: "", identity: "", appearance: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" }, sendAppearanceImages: true, openings: [] });
	const chat = createConversationWithHistory(database, { name: "Snapshot", participants: [{ definition: definition("Ann") }] });
	for (const namespace of ["box:probe", "box:other"]) database.query("INSERT INTO library_data (namespace, key, value, revision) VALUES (?, 'avatar:Ann', ?, 3)").run(namespace, namespace);
	const box = await load(`export default {
		read: (_, { snapshot }) => { globalThis.kept = snapshot; return { view: snapshot({ scope: "library", prefix: "" }), status: "ok" }; },
		moves: { render: () => typeof globalThis.kept },
		dependencies: () => { try { return globalThis.kept({ scope: "library", prefix: "" }); } catch (error) { return error.message; } },
	};`);
	const read = <T>(run: (window: BoxWindowRead<undefined, undefined>) => T) => runConversationReadTransaction(database, (db) => run({
		db, conversationId: chat.id, summary: readConversationSummaryFromConnection(db, chat.id)!, // @approved The Chat was just created.
		history: readSelectedHistoryFromConnection(db, chat.id, { conversationData: false })!, setup: undefined, state: undefined, // @approved The Chat was just created.
	}));
	expect(read((window) => box.read?.(window))).toEqual({ snapshot: chat.revision, status: "ok", view: [{ key: "avatar:Ann", value: "box:probe", revision: 3 }] });
	expect(box.moves?.render({}, "Ann")).toBe("undefined");
	expect(box.dependencies?.({ seed: "", intent: "respond", cast: [] }, undefined)).toBe("not a function");
	const sneaky = await load(`export default { read: (_, { snapshot }) => ({ view: snapshot({ scope: "library", prefix: "", namespace: "box:other" }) }) };`);
	expect(() => read((window) => sneaky.read?.(window))).toThrow("snapshot query");
	database.close();
});

const passage = { messageId: 1, speaker: "Ann", authorId: 1, content: "The storm breaks." };
const digestWindow = { passage, preceding: [], seed: "seed", cast: [], data: {} };
const tense: DecisionAnswer = { type: "choice", choice: "tense", probabilities: { tense: 1 } };
const contextDatabase = openInitializedDatabase({ path: ":memory:" });
const digestContext = (decide: DigestContext["decide"], signal = new AbortController().signal): DigestContext =>
	({ decide, signal, llm: () => undefined, embed: async () => [], database: contextDatabase });

test("decide answers a digest with entries, once per call, and a refused answer fails the digest", async () => {
	const box = await load(`export default { records: { digest: { window: 0, run: async (_, { decide }) => {
		const answers = await decide({ passage: "p" }, { mood: { type: "choice" } });
		try { await decide({}, {}); } catch (error) { return { answers, again: error.message }; }
	} } } };`);
	const asked: unknown[] = [];
	const answered = digestContext(async (state, questions) => { asked.push([state, questions]); return new Map([["mood", tense]]); });
	expect(await box.records?.digest?.run(digestWindow, answered)).toEqual({ answers: [["mood", tense]], again: "decide may be called once per digest." });
	expect(asked).toEqual([[{ passage: "p" }, { mood: { type: "choice" } }]]);
	const refused = digestContext(() => Promise.reject(new Error("Decision Model request failed with HTTP 500.")));
	await expect(box.records?.digest?.run(digestWindow, refused)).rejects.toThrow("The probe Box's records.digest.run threw Error: Decision Model request failed with HTTP 500.");
});

test("a decide pending when its job is cancelled rejects in the guest, and its late answer is dropped", async () => {
	const box = await load(`export default { records: { digest: { window: 0, run: async (_, { decide }) => {
		try { return await decide({}, { mood: { type: "choice" } }); } catch (error) { throw new Error("the guest saw: " + error.message); }
	} } } };`);
	const held = Promise.withResolvers<ReadonlyMap<string, DecisionAnswer>>();
	const asked = Promise.withResolvers<void>();
	const job = new AbortController();
	const run = box.records?.digest?.run(digestWindow, digestContext(() => { asked.resolve(); return held.promise; }, job.signal));
	await asked.promise;
	job.abort();
	await expect(run).rejects.toThrow("The probe Box's records.digest.run threw Error: the guest saw: The probe Box's digest was cancelled.");
	held.resolve(new Map([["mood", tense]]));
	await held.promise;
});

test("a digest that leaves its decide unawaited and returns aborts that request as it ends", async () => {
	const box = await load(`export default { records: { digest: { window: 0, run: async (_, { decide }) => {
		void decide({}, { mood: { type: "choice" } });
		return { mood: "tense" };
	} } } };`);
	const signals: (AbortSignal | undefined)[] = [];
	const forgotten = digestContext((_state, _questions, options) => { signals.push(options?.signal); return new Promise(() => {}); });
	expect(await box.records?.digest?.run(digestWindow, forgotten)).toEqual({ mood: "tense" });
	expect(signals.map((signal) => signal?.aborted)).toEqual([true]);
});

// @approved
//  A digest stopped inside an endless promise chain, while its module holds
// 8 MiB, would leave that heap behind in a shared runtime until loading
// `logic.js` ran out of it; each digest's runtime is its own, so the next one
// starts clean.
test("digests stopped inside an endless promise chain leave nothing that fails a later digest", async () => {
	const box = await load(`const kept = new Uint8Array(8 * 1024 * 1024).fill(1);
	export default { records: { digest: { window: 0, run: async ({ seed }, { decide }) => {
		await decide({}, {});
		if (seed === "valid") return { kept: kept.length };
		const spin = () => Promise.resolve().then(spin);
		return spin();
	} } } };`);
	const answered = digestContext(async () => new Map());
	for (let attempt = 0; attempt < 6; attempt += 1) await expect(box.records?.digest?.run(digestWindow, answered)).rejects.toThrow("The probe Box's records.digest.run");
	expect(await box.records?.digest?.run({ ...digestWindow, seed: "valid" }, answered)).toEqual({ kept: 8 * 1024 * 1024 });
});

// @approved
//  Each digest runs in its own context, created with its `decide`, so a
// guest that keeps `decide` in a global while its request is pending has
// left it nowhere `advance` or another digest runs.
test("a digest that keeps decide in a global while it is pending leaves it undefined for a concurrent advance and a concurrent second digest", async () => {
	const box = await load(`export default {
		records: { digest: { window: 0, run: async ({ seed }, { decide }) => {
			if (seed !== "keeper") return { saw: typeof globalThis.saved };
			globalThis.saved = decide;
			return await decide({}, { mood: { type: "choice" } });
		} } },
		advance: { run: async () => ({ items: [{ text: typeof globalThis.saved, priority: 1 }] }) },
	};`);
	const keeper = new AbortController();
	const asked = Promise.withResolvers<void>();
	const kept = box.records?.digest?.run({ ...digestWindow, seed: "keeper" }, digestContext(() => { asked.resolve(); return new Promise(() => {}); }, keeper.signal));
	await asked.promise;
	expect(await box.advance?.run({ setup: undefined, dependencies: undefined, state: undefined, moves: [] })).toEqual({ items: [{ text: "undefined", priority: 1 }] });
	expect(await box.records?.digest?.run(digestWindow, digestContext(async () => new Map()))).toEqual({ saw: "undefined" });
	keeper.abort();
	await expect(kept).rejects.toThrow("The probe Box's digest was cancelled.");
});

test("identical advances in separate operations cannot see an earlier call or another Chat's setup", async () => {
	const guest = await sandboxedBox("probe", `let calls = 0, previous; export default { advance: { run: ({ setup }) => {
		const text = JSON.stringify([++calls, previous ?? null]); previous = setup; return { items: [{ text, priority: 1 }] };
	} } };`);
	loaded.push(guest.dispose);
	const run = (setup: string) => guest.operation(() => guest.box.advance?.run({ setup, dependencies: undefined, state: undefined, moves: [] }));
	const first = await run("first Chat");
	expect(await run("first Chat")).toEqual(first);
	expect(await run("other Chat")).toEqual(first);
});

test("a module that retains its exhausted heap cannot poison the next operation", async () => {
	const guest = await sandboxedBox("probe", `const kept = []; export default { records: { initial: 0, fold: (state, record) => {
		if (record.leak) while (true) kept.push(new ArrayBuffer(1 << 20)); return state + record.text.length;
	} } };`);
	loaded.push(guest.dispose);
	await expect(guest.operation(() => guest.box.records?.foldAll?.(0, [{ leak: true }], undefined))).rejects.toThrow("The probe Box's records.fold ran out of its 64 MiB heap.");
	expect(await guest.operation(() => guest.box.records?.foldAll?.(0, [{ text: "x".repeat(1024 * 1024) }], undefined))).toBe(1024 * 1024);
});

test("a history larger than the call cap folds in bounded entries, but one oversized record fails", async () => {
	const guest = await sandboxedBox("probe", `export default { records: { initial: 0, fold: (state, record, setup) => state + record.text.length + setup } };`);
	loaded.push(guest.dispose);
	const records = Array.from({ length: 32 }, () => ({ text: "界".repeat(48 * 1024) }));
	expect(Buffer.byteLength(JSON.stringify(records))).toBeGreaterThan(SANDBOX_JSON_BYTES);
	expect(await guest.operation(() => guest.box.records?.foldAll?.(0, records, 7))).toBe(records.reduce((state, record) => state + record.text.length + 7, 0));
	await expect(guest.operation(() => guest.box.records?.foldAll?.(0, [{ text: "界".repeat(SANDBOX_JSON_BYTES / 2) }], 7))).rejects.toThrow("The probe Box's records.fold input is over the 4 MiB limit.");
});


test("a host allocation trap names the hook, disposal is safe, and the next operation recovers", async () => {
	const guest = await sandboxedBox("probe", `const kept = []; export default { records: { initial: 0, fold: (state, record) => {
		if (record.leak) while (true) kept.push(new ArrayBuffer(1 << 20)); return state + record.text.length;
	} } };`);
	loaded.push(guest.dispose);
	await guest.operation(() => {
		expect(() => guest.box.records?.foldAll?.(0, [{ leak: true }], undefined)).toThrow("The probe Box's records.fold ran out of its 64 MiB heap.");
		expect(() => guest.box.records?.foldAll?.(0, [{ text: "x".repeat(1024 * 1024) }], undefined)).toThrow("The probe Box's records.fold threw RuntimeError:");
	});
	expect(await guest.operation(() => guest.box.records?.foldAll?.(0, [{ text: "ok" }], undefined))).toBe(2);
	expect(() => guest.dispose()).not.toThrow();
});


test("one operation shares its module across Moves and fold chunks, then the next operation resets it", async () => {
	const guest = await sandboxedBox("probe", `let calls = 0; export default {
		moves: { render: () => String(++calls) },
		records: { initial: 0, fold: () => ++calls },
		advance: { run: () => ({ items: [{ text: String(++calls), priority: 1 }] }) },
	};`);
	loaded.push(guest.dispose);
	const input = { setup: undefined, dependencies: undefined, state: undefined, moves: [] };
	await guest.operation(async () => {
		expect([guest.box.moves?.render({}, "Ann"), guest.box.moves?.render({}, "Ann")]).toEqual(["1", "2"]);
		expect(guest.box.records?.foldAll?.(0, Array.from({ length: 201 }, () => 0), undefined)).toBe(203);
		expect(await guest.box.advance?.run(input)).toEqual({ items: [{ text: "204", priority: 1 }] });
	});
	expect(await guest.operation(() => guest.box.advance?.run(input))).toEqual({ items: [{ text: "1", priority: 1 }] });
});

const installedProbe = async () => {
	const scratch = join(import.meta.dir, "../../../.scratch");
	mkdirSync(scratch, { recursive: true });
	const folder = mkdtempSync(join(scratch, "sandbox-operations-"));
	mkdirSync(join(folder, "probe"));
	await Bun.write(join(folder, "probe/descriptor.json"), JSON.stringify({
		id: "probe", sdk: 2, label: "Probe", summary: "Tests operation boundaries.", role: "system", startsEnabled: false, instructions: "", alwaysRender: true,
		setup: { schema: { type: "string" }, initial: "" }, record: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false }, window: { icon: "box", size: { width: 12, height: 12 } },
	}));
	await Bun.write(join(folder, "probe/ui.js"), "");
	await Bun.write(join(folder, "probe/logic.js"), `let calls = 0; const kept = []; export default {
		setupError: (setup) => { if (setup === "leak") while (true) kept.push(new ArrayBuffer(1 << 20)); },
		records: { initial: 0, fold: (state, record) => { calls++; return state + record.n; } },
		dependencies: () => calls,
		advance: { run: ({ dependencies }) => ({ items: [{ text: String(dependencies), priority: 1 }] }) },
		read: () => ({ view: null }),
	};`);
	mkdirSync(join(folder, "unused"));
	await Bun.write(join(folder, "unused/descriptor.json"), (await Bun.file(join(folder, "probe/descriptor.json")).text()).replaceAll('"probe"', '"unused"'));
	await Bun.write(join(folder, "unused/ui.js"), "");
	await Bun.write(join(folder, "unused/logic.js"), await Bun.file(join(folder, "probe/logic.js")).text());
	await loadBoxes([builtInBoxes, folder]);
	return async () => { await loadBoxes([builtInBoxes]); rmSync(folder, { recursive: true, force: true }); };
};

test("a setup command that exhausts the heap does not poison later setup saves", async () => {
	const restore = await installedProbe();
	const database = openObservedDatabase();
	try {
		const chat = createChat(database);
		insertBox(database, chat.id, "probe");
		const app = createConversationRoutes(database);
		const save = async (setup: string) => app.handle(new Request(`http://localhost/api/conversations/${chat.id}/commands`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ expectedRevision: readConversationSummaryFromConnection(drizzle(database), chat.id)!.revision, action: { type: "set-box-setup", box: "probe", setup } }), // @approved This test created the Chat.
		}));
		expect(await (await save("leak")).text()).toContain("The probe Box's setupError ran out of its 64 MiB heap.");
		expect((await save("x".repeat(1024 * 1024))).status).toBe(200);
		expect((await save("ok")).status).toBe(200);
	} finally { database.close(); await restore(); }
});

test("sending an unchanged preview uses the same fold and dependency context as creating it", async () => {
	const restore = await installedProbe();
	const database = openObservedDatabase();
	try {
		const chat = createChat(database);
		const instance = insertBox(database, chat.id, "probe");
		const message = database.query<{ id: number }, [number]>("INSERT INTO messages (conversation_id, position, timestamp) VALUES (?, 0, '2026-01-01') RETURNING id").get(chat.id)!;
		const variant = database.query<{ id: number }, [number]>("INSERT INTO message_variant (message_id, position, content, timestamp, selected) VALUES (?, 0, 'A record.', '2026-01-01', 1) RETURNING id").get(message.id)!;
		writeAutomaticRecord(drizzle(database), boxDescriptor("probe"), instance, variant.id, { n: 1 }, sha256("A record."));
		withProfile(database);
		const app = createConversationRoutes(database, { masterKey: key, fetch: captureModelFetch(() => {}) });
		const post = (path: string, body: { kind: "send"; content: string; expectedRevision?: number; previewId?: string; promptPlan?: unknown }) => app.handle(new Request(`http://localhost/api/conversations/${chat.id}/generations${path}`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
		}));
		const preview = await post("/preview", { kind: "send", content: "Continue." });
		expect(preview.status).toBe(200);
		const { previewId, promptPlan } = await preview.json();
		const expectedRevision = readConversationSummaryFromConnection(drizzle(database), chat.id)!.revision; // @approved This test created the Chat.
		const sent = await post("", { kind: "send", content: "Continue.", expectedRevision, previewId, promptPlan });
		const accepted = await sent.json();
		expect(accepted).toMatchObject({ outcome: "accepted" });
		const { generationId } = accepted;
		await completeGeneration(app, chat.id, generationId);
	} finally { database.close(); await restore(); }
});


test("a setup command allocates only for its target Box, and a rename allocates no sandbox", async () => {
	const restore = await installedProbe();
	const database = openObservedDatabase();
	try {
		const chat = createChat(database);
		insertBox(database, chat.id, "probe");
		insertBox(database, chat.id, "unused");
		const app = createConversationRoutes(database);
		const Memory = WebAssembly.Memory;
		let allocations = 0;
		WebAssembly.Memory = class extends Memory {
			constructor(descriptor: WebAssembly.MemoryDescriptor) { super(descriptor); allocations++; }
		};
		try {
			const command = (action: ConversationAction) => app.handle(new Request(`http://localhost/api/conversations/${chat.id}/commands`, {
				method: "POST", headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: readConversationSummaryFromConnection(drizzle(database), chat.id)!.revision, action }), // @approved This test created the Chat.
			}));
			expect((await command({ type: "set-box-setup", box: "probe", setup: "ok" })).status).toBe(200);
			expect(allocations).toBe(1);
			allocations = 0;
			expect((await command({ type: "rename-conversation", name: "Renamed" })).status).toBe(200);
			expect(allocations).toBe(0);
		} finally { WebAssembly.Memory = Memory; }
	} finally { database.close(); await restore(); }
});

test("a standalone read recovers after its snapshot allocation traps", async () => {
	const guest = await sandboxedBox("probe", `const kept = []; export default { read: ({ setup }, { snapshot }) => {
		if (setup) { try { while (true) kept.push(new ArrayBuffer(1 << 20)); } catch {} snapshot({}); }
		return { view: "ok" };
	} };`);
	loaded.push(guest.dispose);
	const read = (setup: boolean) => guest.guestRead?.({ setup, state: undefined, human: null, cast: [] }, () => JSON.stringify("x".repeat(1 << 20)));
	expect(() => read(true)).toThrow("The probe Box's read threw RuntimeError:");
	expect(() => read(false)).toThrow("The probe Box's read is waiting for its sandbox runtime to recover.");
	let recovered;
	for (let attempt = 0; attempt < 100 && recovered === undefined; attempt++) {
		await Bun.sleep(10);
		try { recovered = read(false); }
		catch (error) { expect(String(error)).toContain("The probe Box's read is waiting for its sandbox runtime to recover."); }
	}
	expect(recovered).toEqual({ view: "ok" });
});
