import { Type, type Static } from "@sinclair/typebox";

export const tipMove = Type.Object({ coins: Type.Integer({ minimum: 1 }) });
export type TipMove = Static<typeof tipMove>;

/** @approved The coins dropped in one passage; the window reads the jar's total in the same shape. */
export const tipRecord = Type.Object({ coins: Type.Integer({ minimum: 0 }) });
export type TipRecord = Static<typeof tipRecord>;
