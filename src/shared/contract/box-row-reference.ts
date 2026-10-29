import { Type } from "@sinclair/typebox";

export const MessageId = Type.Integer({ rowReference: "message" });
export const VariantId = Type.Integer({ rowReference: "variant" });
export const ParticipantId = Type.Integer({ rowReference: "participant" });
// Type.Record retains the key pattern, but discards the key schema's other annotations.
export const ParticipantKey = Type.String({ pattern: "^(?:[0-9])+$", rowReference: "participant" });
