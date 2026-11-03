import { expect, test } from "bun:test";
import { join } from "node:path";
import { assertChecked } from "../../shared/contract/box-descriptor";
import { sandboxedDescriptor, sandboxedDescriptorFile } from "../../shared/contract/box-sandboxed";
import { oneAtATime, stagedMoves } from "./BoxFrame";

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
