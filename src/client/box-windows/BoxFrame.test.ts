import { expect, test } from "bun:test";
import { join } from "node:path";
import { assertChecked } from "../../shared/contract/box-descriptor";
import { sandboxedDescriptor, sandboxedDescriptorFile } from "../../shared/contract/box-sandboxed";
import { stagedMoves } from "./BoxFrame";

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
