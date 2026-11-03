import { afterEach, expect, test } from "bun:test";
import { openInitializedDatabase } from "../database/database";
import { createConversationWithHistory } from "../test-fixtures/conversation";
import type { DecisionAnswer } from "../../shared/contract/decision-model";
import type { DigestContext } from "./contract";
import { readBoxWindow } from "./window";
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
	const definition = (name: string) => ({ name, prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" }, openings: [] });
	const chat = createConversationWithHistory(database, { name: "Snapshot", participants: [{ definition: definition("Ann") }] });
	for (const namespace of ["box:probe", "box:other"]) database.query("INSERT INTO library_data (namespace, key, value, revision) VALUES (?, 'avatar:Ann', ?, 3)").run(namespace, namespace);
	const box = await load(`export default {
		read: (_, { snapshot }) => { globalThis.kept = snapshot; return { view: snapshot({ scope: "library", prefix: "" }), status: "ok" }; },
		moves: { render: () => typeof globalThis.kept },
		dependencies: () => { try { return globalThis.kept({ scope: "library", prefix: "" }); } catch (error) { return error.message; } },
	};`);
	expect(readBoxWindow(database, chat.id, "probe", {}, (window) => box.read?.(window))).toEqual({ snapshot: chat.revision, status: "ok", view: [{ key: "avatar:Ann", value: "box:probe", revision: 3 }] });
	expect(box.moves?.render({}, "Ann")).toBe("undefined");
	expect(box.dependencies?.({ seed: "", intent: "respond", cast: [] }, undefined)).toBe("not a function");
	const sneaky = await load(`export default { read: (_, { snapshot }) => ({ view: snapshot({ scope: "library", prefix: "", namespace: "box:other" }) }) };`);
	expect(() => readBoxWindow(database, chat.id, "probe", {}, (window) => sneaky.read?.(window))).toThrow("snapshot query");
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
