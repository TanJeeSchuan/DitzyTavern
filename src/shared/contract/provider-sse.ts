import { Type } from "@sinclair/typebox";

// One variant per field that proves an OpenAI-compatible streaming provider is
// still working. Activity is read from the first streamed choice only; a
// wrongly typed field (for example `content: 42`) never counts.
export const providerActivityChoice = Type.Union([
	Type.Object({ delta: Type.Object({ content: Type.String() }) }),
	Type.Object({ delta: Type.Object({ reasoning: Type.String() }) }),
	Type.Object({ delta: Type.Object({ reasoning_content: Type.String() }) }),
	Type.Object({ delta: Type.Object({ reasoning_details: Type.Unknown() }) }),
	Type.Object({ finish_reason: Type.String() }),
]);

// A decodable stream frame: the caller reads its first choice and its `usage`
// payload. Extra choices never participate in the activity decision.
export const providerActivityFrame = Type.Object({
	choices: Type.Optional(Type.Array(Type.Unknown())),
	usage: Type.Optional(Type.Unknown()),
});
