import { afterEach, expect, test } from "bun:test";
import { openInitializedDatabase } from "../database/database";
import { createConversationWithHistory } from "../test-fixtures/conversation";
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
	await expect(load("export default { status: () => null };")).rejects.toThrow("The probe Box's logic.js declares status, which a sandboxed Box cannot.");
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
