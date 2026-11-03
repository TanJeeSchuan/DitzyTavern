import { afterEach, expect, test } from "bun:test";
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
	const box = await load("export default { records: { initial: 0, fold: (total) => total }, read: ({ setup }) => 'x'.repeat(setup) };");
	expect(() => box.records?.foldAll?.(0, [{ text: "x".repeat(SANDBOX_JSON_BYTES) }], undefined)).toThrow("The probe Box's records.fold input is over the 4 MiB limit.");
	expect(() => box.read?.({ setup: SANDBOX_JSON_BYTES, state: undefined })).toThrow("The probe Box's read result is over the 4 MiB limit.");
	expect(box.read?.({ setup: 3, state: undefined })).toBe("xxx");
});

test("an async advance that loops before it returns is stopped, and one that never settles fails", async () => {
	const input = { setup: undefined, state: undefined, moves: [] };
	const looping = await load("export default { advance: { run: async () => { await null; while (true) {} } } };");
	await expect(looping.advance?.run(input)).rejects.toThrow("The probe Box's advance.run ran past its 100 ms limit.");
	const hanging = await load("export default { advance: { run: () => new Promise(() => {}) } };");
	await expect(hanging.advance?.run(input)).rejects.toThrow("The probe Box's advance.run never settled.");
});

test("logic has no clock and no randomness of its own", async () => {
	const attempt = (code: string) => `(() => { try { return String(${code}); } catch (error) { return error.message; } })()`;
	const box = await load(`export default { read: () => [typeof Math.random, typeof Date.now, ${attempt("new Date()")}, ${attempt("new RealDate().getTime()")}, ${attempt("new (new Date(0).constructor)()")}, new Date(0).toISOString()] };`);
	expect(box.read?.({ setup: undefined, state: undefined })).toEqual([
		"undefined", "undefined", "Sandboxed logic has no clock.", "'RealDate' is not defined", "Sandboxed logic has no clock.", "1970-01-01T00:00:00.000Z",
	]);
});

test("a guest throw crosses as the host's error, naming the Box and hook", async () => {
	const box = await load("export default { moves: { render: () => { throw new RangeError('no coins'); } } };");
	expect(() => box.moves?.render({}, "Ann")).toThrow("The probe Box's moves.render threw RangeError: no coins");
});

test("logic.js may declare only the hooks a sandboxed Box supports", async () => {
	await expect(load("export default { setupError: () => undefined };")).rejects.toThrow("The probe Box's logic.js declares setupError, which a sandboxed Box cannot.");
	await expect(load("export default { read: 1 };")).rejects.toThrow("The probe Box's logic.js declares read, which must be functions.");
});
