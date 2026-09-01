// ==[HUMAN APPROVED]== The generation-owned JSON vocabulary shared by persistence and transport.
// Declared in this leaf module so the Generation Settings contract and
// Generation provenance can both import it without an import cycle.
export type GenerationJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly GenerationJsonValue[]
	| Readonly<{ [key: string]: GenerationJsonValue }>;

export type GenerationJsonObject = Readonly<{ [key: string]: GenerationJsonValue }>;
