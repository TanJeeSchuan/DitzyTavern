import { Type, type Static } from "@sinclair/typebox";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const imageHash = Type.String({ pattern: "^[0-9a-f]{64}$" });

export const portrait = Type.Object({
	hash: imageHash,
	focalX: Type.Number({ minimum: 0, maximum: 1 }),
	focalY: Type.Number({ minimum: 0, maximum: 1 }),
});

export const imageParams = Type.Object({ hash: imageHash });
export const imageUploadBody = Type.Object({ data: Type.String() });
export const imageUploadResponse = Type.Object({ hash: imageHash });

export type Portrait = Static<typeof portrait>;
