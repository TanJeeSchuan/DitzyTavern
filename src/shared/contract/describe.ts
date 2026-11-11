import { Type, type Static } from "@sinclair/typebox";
import { imageHash } from "./image";

export const describeRequest = Type.Object({ hashes: Type.Array(imageHash, { minItems: 1 }), ask: Type.Optional(Type.String()) });
export const description = Type.Object({ text: Type.String() });
export type DescribeRequest = Static<typeof describeRequest>;

export const DESCRIBE_INSTRUCTION = "Describe the character's face, hair, eyes, build, clothing and distinguishing marks. Describe only their appearance, nothing about personality.";
