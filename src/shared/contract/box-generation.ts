import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { generationJsonValue } from "./json-value";
import { boxDescriptor, boxDescriptors, type BoxId } from "./box";
import { boxValue, type BoxValue } from "./box-value";

/** @approved The records one Generation writes, by Box id, each stamped with the Box instance captured with it. */
export const boxRecords = Type.Record(Type.String(), Type.Object({ instance: Type.String(), record: boxValue }));
export type BoxRecords = Static<typeof boxRecords>;

export const boxAdmission = Type.Union([Type.Literal("admitted"), Type.Literal("allowance"), Type.Literal("oversized"), Type.Literal("context-limit")]);
export type BoxAdmission = Static<typeof boxAdmission>;
// @approved
//  What one captured Box contributed to a Generation, for inspection: its own
// `trace`, which only the Box reads; its allowance; the host's admission of
// each item it returned, in its order; and its block's text as budgeted and
// as sent, which differ once the writer edits the inspected Prompt Plan.
export const boxTrace = Type.Object({
	trace: Type.Optional(generationJsonValue),
	allowance: Type.Optional(Type.Integer()),
	items: Type.Array(Type.Object({ text: Type.String(), admission: boxAdmission })),
	automaticText: Type.String(),
	finalText: Type.String(),
});
export type BoxTrace = Static<typeof boxTrace>;
/** @approved Each captured Box's trace, keyed by `box:<id>`. */
export const boxTraces = Type.Record(Type.String(), boxTrace);
export type BoxTraces = Static<typeof boxTraces>;

// @approved
//  The Moves on one Human-authored Message, by Box id, each list in the order
//  the Box resolves them. Each list is checked against its own Box's Move
//  schema and limit wherever it is accepted or read back.
export const boxMoves = Type.Record(Type.String(), Type.Array(boxValue, { minItems: 1 }));
export type BoxMoves = Static<typeof boxMoves>;

/** @approved Why `moves` are refused, a Box that takes no Moves or a list its Box's Move schema or limit rejects; undefined when every list passes. */
export const boxMovesError = (moves: BoxMoves): string | undefined => Object.entries(moves).flatMap(([id, list]) => {
	const declared = boxDescriptors().get(id)?.moves;
	if (declared === undefined) return [`No ${id} Box takes Moves.`];
	return list.length > 0 && list.length <= declared.max && list.every((move) => Value.Check(declared.schema, move)) ? [] : [`The ${boxDescriptor(id).label} Moves do not match their schema.`];
})[0];

export const hasMoves = (moves: BoxMoves | undefined): boolean => Object.values(moves ?? {}).some((list) => list.length > 0);
/** @approved Seat-bound Moves belong to the human seat that staged them, as well as to their Chat. */
export const seatBound = (id: BoxId): boolean => boxDescriptors().get(id)?.moves?.seatBound === true;
export const sameMoves = (left: BoxMoves | undefined, right: BoxMoves | undefined): boolean =>
	Object.keys({ ...left, ...right }).every((id) => JSON.stringify(left?.[id] ?? []) === JSON.stringify(right?.[id] ?? []));

/** @approved The Moves of the Boxes `keep` accepts. */
export const pickMoves = (moves: BoxMoves, keep: (id: BoxId) => boolean): BoxMoves => Object.fromEntries(Object.entries(moves).filter(([id]) => keep(id)));

/** @approved Replaces one Box's Moves; a Box left with none drops out. */
export const replaceMoves = (moves: BoxMoves, id: BoxId, list: readonly BoxValue[]): BoxMoves =>
	pickMoves({ ...moves, [id]: [...list] }, (box) => box !== id || list.length > 0);

/** @approved A Move's chip label, as its own Box writes it. */
export function moveLabel(id: BoxId, move: BoxValue): string {
	// SAFETY: a Box's Moves are checked against its own Move schema, which its label takes.
	const label = boxDescriptor(id).moves?.label as ((move: BoxValue) => string) | undefined;
	if (label === undefined) throw new Error(`The ${id} Box takes no Moves.`);
	return label(move);
}
