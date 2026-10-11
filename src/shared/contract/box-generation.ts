import { Type, type Static } from "@sinclair/typebox";
import { worldClockRecordSlot } from "./box";
import { raceMove, raceRecordSlot, raceRecord } from "./race";
import { MAX_RACE_MOVES } from "../race-moves";
import { MAX_PHONE_MOVES, phoneMove } from "./phone";

/** @approved The records one Generation writes, each stamped with the Box instance captured with it. */
export const boxRecords = Type.Object({ race: Type.Optional(Type.Object({ instance: Type.String(), record: raceRecord })) });
export type BoxRecords = Static<typeof boxRecords>;

export const boxRecordSlots = { "world-clock": worldClockRecordSlot, race: raceRecordSlot };

// @approved
//  The Moves on one Human-authored Message, per Box, each list in the order
//  the Box resolves them.
export const boxMoves = Type.Object({
	race: Type.Optional(Type.Array(raceMove, { minItems: 1, maxItems: MAX_RACE_MOVES })),
	phone: Type.Optional(Type.Array(phoneMove, { minItems: 1, maxItems: MAX_PHONE_MOVES })),
});
export type BoxMoves = Static<typeof boxMoves>;

export const hasMoves = (moves: BoxMoves | undefined): boolean => Object.values(moves ?? {}).some((list) => list.length > 0);
