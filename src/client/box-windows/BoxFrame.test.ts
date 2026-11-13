import { expect, test } from "bun:test";
import { join } from "node:path";
import { assertChecked } from "../../shared/contract/box-descriptor";
import { sandboxedDescriptor, sandboxedDescriptorFile } from "../../shared/contract/box-sandboxed";
import { completeFrameCommit, newestFrameRead, oneAtATime, stagedMoves } from "./BoxFrame";

const file: unknown = await Bun.file(join(import.meta.dir, "../../../e2e/fixtures/boxes/tip-jar-sandboxed/descriptor.json")).json();
assertChecked(sandboxedDescriptorFile, file, "The sandboxed Tip Jar's descriptor.json");
const tipJar = sandboxedDescriptor(file);

test("a cyclic Move that passes the Move schema is refused before it reaches the composer", () => {
	const move = { coins: 1, loop: {} };
	move.loop = move;
	expect(stagedMoves(tipJar, [move])).toEqual({ refused: "It staged Moves that are not JSON." });
});

test("staged Moves reach the composer as a JSON copy, within the Box's schema and count", () => {
	const move = { coins: 1 };
	const accepted = stagedMoves(tipJar, [move]);
	expect(accepted).toEqual({ moves: [{ coins: 1 }] });
	expect("moves" in accepted && accepted.moves[0]).not.toBe(move);
	expect(stagedMoves(tipJar, [move, move])).toEqual({ refused: "It staged Moves that do not match its Move schema." });
});

// @approved
//  A guest that fires uploads in a loop gets one through at a time: the rest
// are refused while it is in flight, not queued, and the next one after it
// settles goes through.
test("an upload asked for while another is in flight is refused, and the next one after it settles runs", async () => {
	const started: number[] = [];
	const pending = Promise.withResolvers<void>();
	const upload = oneAtATime(async (index: number) => { started.push(index); await pending.promise; return `uploaded ${index}`; }, () => "busy");
	const first = upload(1);
	expect(await Promise.all([upload(2), upload(3)])).toEqual(["busy", "busy"]);
	pending.resolve();
	expect(await first).toBe("uploaded 1");
	expect(await upload(4)).toBe("uploaded 4");
	expect(started).toEqual([1, 4]);
});

test("an applied frame commit delivers its saved read before acknowledging the guest", async () => {
	const read = Promise.withResolvers<{ snapshot: number; status: null; view: { saved: boolean } }>();
	const delivered: string[] = [];
	const result = completeFrameCommit(null, read.promise, (current) => {
		expect(current).toEqual({ snapshot: 2, status: null, view: { saved: true } });
		delivered.push("read");
	}).then((outcome) => { delivered.push("reply"); return outcome; });
	await Promise.resolve();
	expect(delivered).toEqual([]);
	read.resolve({ snapshot: 2, status: null, view: { saved: true } });
	expect(await result).toEqual({ outcome: "applied" });
	expect(delivered).toEqual(["read", "reply"]);
});

test("an applied frame commit remains applied when its follow-up read fails or the Chat disappears", async () => {
	for (const read of [() => Promise.reject(new Error("read failed")), () => Promise.resolve(null)]) {
		const delivered: unknown[] = [];
		expect(await completeFrameCommit(null, read(), (current) => delivered.push(current))).toEqual({ outcome: "applied" });
		expect(delivered).toEqual([]);
	}
});

test("a frame commit that did not land returns its refusal and current read without delivering an applied read", async () => {
	const current = { snapshot: 3, status: null, view: { saved: false } };
	for (const outcome of ["conflict", "refused"] as const) {
		const delivered: unknown[] = [];
		expect(await completeFrameCommit({ outcome, reason: "changed" }, Promise.resolve(current), (read) => delivered.push(read))).toEqual({ outcome, reason: "changed", current });
		expect(delivered).toEqual([]);
	}
});


test("a late placeholder cannot replace a newer frame read, while same-revision delegate updates still arrive", () => {
	const saved = { snapshot: 5, status: null, view: { phase: "running" } };
	const placeholder = { snapshot: 4, status: null, view: { phase: "setup" } };
	const delegated = { snapshot: 5, status: null, view: { phase: "finished" } };
	expect(newestFrameRead(saved, placeholder)).toEqual(saved);
	expect(newestFrameRead(saved, delegated)).toEqual(delegated);
	expect(newestFrameRead(placeholder, saved)).toEqual(saved);
	expect(newestFrameRead(undefined, placeholder)).toEqual(placeholder);
});
