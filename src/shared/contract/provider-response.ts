import { Type, type Static } from "@sinclair/typebox";
import { generationJsonValue } from "./json-value";

export const catalogBody = Type.Object({ data: Type.Array(generationJsonValue) });
export const modelCatalogEntry = Type.Object({ id: Type.String() });
export type ModelCatalogEntry = Static<typeof modelCatalogEntry>;

export const embeddingResponse = Type.Object({ data: Type.Array(Type.Object({ embedding: Type.Array(Type.Number(), { minItems: 1 }) })) });
export type EmbeddingResponse = Static<typeof embeddingResponse>;

export const providerDiagnosticError = Type.Object({
	name: Type.String(),
	message: Type.String(),
	cause: Type.Optional(Type.Object({ name: Type.String(), message: Type.String() })),
	statusCode: Type.Optional(Type.Number()),
	status: Type.Optional(Type.Number()),
	responseBody: Type.Optional(Type.String()),
	responseHeaders: Type.Optional(Type.Record(Type.String(), Type.String())),
});
export type ProviderDiagnosticError = Static<typeof providerDiagnosticError>;
