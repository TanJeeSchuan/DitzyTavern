import { Type, type Static } from "@sinclair/typebox";
import { worldClockRecordSlot } from "./box";
import { raceRecordSlot, raceRecord } from "./race";

export const boxRecords = Type.Object({ race: Type.Optional(raceRecord) });
export type BoxRecords = Static<typeof boxRecords>;

export const boxRecordSlots = { "world-clock": worldClockRecordSlot, race: raceRecordSlot };
