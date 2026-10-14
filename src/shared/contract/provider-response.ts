import { Type, type Static } from "@sinclair/typebox";

export const catalogBody = Type.Object({ data: Type.Array(Type.Unknown()) });
export const modelCatalogEntry = Type.Object({ id: Type.String() });
export type ModelCatalogEntry = Static<typeof modelCatalogEntry>;

export const embeddingResponse = Type.Object({ data: Type.Array(Type.Object({ embedding: Type.Array(Type.Number(), { minItems: 1 }) })) });
export type EmbeddingResponse = Static<typeof embeddingResponse>;

export const providerDiagnosticError = Type.Object({
	name: Type.String(),
	message: Type.String(),
	causeName: Type.Optional(Type.String()),
	statusCode: Type.Optional(Type.Number()),
	status: Type.Optional(Type.Number()),
	responseBody: Type.Optional(Type.String()),
	responseHeaders: Type.Optional(Type.Record(Type.String(), Type.String())),
});
export type ProviderErrorLike = Static<typeof providerDiagnosticError>;

export const providerErrorCause = Type.Object({ name: Type.Optional(Type.String()) });
