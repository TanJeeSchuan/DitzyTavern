import { Type, type Static } from "@sinclair/typebox";
import { generationJsonValue } from "./json-value";

export const catalogBody = Type.Object({ data: Type.Array(generationJsonValue) });
export const modelCatalogEntry = Type.Object({ id: Type.String() });
export type ModelCatalogEntry = Static<typeof modelCatalogEntry>;

export const embeddingResponse = Type.Object({ data: Type.Array(Type.Object({ embedding: Type.Array(Type.Number(), { minItems: 1 }) })) });
export type EmbeddingResponse = Static<typeof embeddingResponse>;

