export type { GenerationJsonValue } from "./contract/json-value";
import type { GenerationJsonValue } from "./contract/json-value";

export type GenerationJsonObject = Readonly<{ [key: string]: GenerationJsonValue }>;
