import { Type, type Static } from "@sinclair/typebox";

export const imageHash = Type.String({ pattern: "^[0-9a-f]{64}$" });

export const portrait = Type.Object({
	hash: imageHash,
	focalX: Type.Number({ minimum: 0, maximum: 1 }),
	focalY: Type.Number({ minimum: 0, maximum: 1 }),
});

export const imageParams = Type.Object({ hash: imageHash });

export const inlineImages = Type.Optional(Type.Array(Type.String()));

export type Portrait = Static<typeof portrait>;
