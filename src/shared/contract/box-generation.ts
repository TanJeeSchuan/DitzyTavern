import { Type, type Static } from "@sinclair/typebox";
import { worldClockRecordSlot } from "./box";
import { raceMove, raceRecordSlot, raceRecord } from "./race";

export const boxRecords = Type.Object({ race: Type.Optional(raceRecord) });
export type BoxRecords = Static<typeof boxRecords>;

export const boxRecordSlots = { "world-clock": worldClockRecordSlot, race: raceRecordSlot };

// @approved
//  The Moves on one Human-authored Message, per Box, each list in the order
//  the Box resolves them.
export const boxMoves = Type.Object({ race: Type.Optional(Type.Array(raceMove, { minItems: 1, maxItems: 12 })) });
export type BoxMoves = Static<typeof boxMoves>;
