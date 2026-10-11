import { Type, type Static, type TArray, type TObject, type TOptional, type TString } from "@sinclair/typebox";
import { boxDescriptors, moveBoxIds, recordBoxIds, type BoxDescriptors, type MoveBoxId, type RecordBoxId } from "./box";
import { boxRecordSlot } from "./box-digest";

type RecordOf<Id extends RecordBoxId> = BoxDescriptors[Id]["record"];

// SAFETY: the entries are exactly the record Boxes, each with its own record schema.
const generationRecords = Object.fromEntries(recordBoxIds.map((id) => [id, Type.Optional(Type.Object({ instance: Type.String(), record: boxDescriptors[id].record }))])) as {
	[Id in RecordBoxId]: TOptional<TObject<{ instance: TString; record: RecordOf<Id> }>>
};
/** @approved The records one Generation writes, each stamped with the Box instance captured with it. */
export const boxRecords = Type.Object(generationRecords);
export type BoxRecords = Static<typeof boxRecords>;

// SAFETY: the entries are exactly the record Boxes, each with its own record schema.
const recordSlots = Object.fromEntries(recordBoxIds.map((id) => [id, boxRecordSlot(boxDescriptors[id].record)])) as { [Id in RecordBoxId]: ReturnType<typeof boxRecordSlot<RecordOf<Id>>> };
export const boxRecordSlots = recordSlots;
export type BoxRecordSlot<Id extends RecordBoxId> = Static<typeof boxRecordSlots[Id]>;
export type BoxRecord<Id extends RecordBoxId> = Static<RecordOf<Id>>;

// SAFETY: the entries are exactly the Move Boxes, each with its own Move schema.
const moveLists = Object.fromEntries(moveBoxIds.map((id) => {
	const { schema, max } = boxDescriptors[id].moves;
	return [id, Type.Optional(Type.Array(schema, { minItems: 1, maxItems: max }))];
})) as { [Id in MoveBoxId]: TOptional<TArray<BoxDescriptors[Id]["moves"]["schema"]>> };
// @approved
//  The Moves on one Human-authored Message, per Box, each list in the order
//  the Box resolves them.
export const boxMoves = Type.Object(moveLists);
export type BoxMoves = Static<typeof boxMoves>;
export type BoxMove = NonNullable<BoxMoves[MoveBoxId]>[number];

export const hasMoves = (moves: BoxMoves | undefined): boolean => Object.values(moves ?? {}).some((list) => list.length > 0);

/** @approved The Moves of the Boxes `keep` accepts. */
export function pickMoves(moves: BoxMoves, keep: (id: MoveBoxId) => boolean): BoxMoves {
	const kept = moveBoxIds.flatMap((id) => moves[id] !== undefined && keep(id) ? [[id, moves[id]]] : []);
	// SAFETY: every entry keeps its own Box's list.
	return Object.fromEntries(kept) as BoxMoves;
}

/** @approved Replaces one Box's Moves; a Box left with none drops out. */
export function replaceMoves(moves: BoxMoves, id: MoveBoxId, list: readonly BoxMove[]): BoxMoves {
	// SAFETY: `list` holds Moves the same Box's chips produced, so the entry keeps its own Box's list type.
	const replaced = { ...moves, [id]: list } as BoxMoves;
	return pickMoves(replaced, (box) => box !== id || list.length > 0);
}

/** @approved A Move's chip label, as its own Box writes it. */
export function moveLabel(id: MoveBoxId, move: BoxMove): string {
	// SAFETY: a Box's Moves decode with its own Move schema, which its label takes.
	const label = boxDescriptors[id].moves.label as (move: BoxMove) => string;
	return label(move);
}
