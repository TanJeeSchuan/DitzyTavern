import { Type } from "@sinclair/typebox";

// One variant per field that proves an OpenAI-compatible streaming provider is
// still working. Any well-typed recognizable field counts as activity, so a
// frame whose only signal is wrongly typed (for example `content: 42`) does
// not reset the Stream Inactivity Timeout.
export const providerActivityFrame = Type.Union([
	Type.Object({ choices: Type.Array(Type.Object({ delta: Type.Object({ content: Type.String() }) })) }),
	Type.Object({ choices: Type.Array(Type.Object({ delta: Type.Object({ reasoning: Type.String() }) })) }),
	Type.Object({ choices: Type.Array(Type.Object({ delta: Type.Object({ reasoning_content: Type.String() }) })) }),
	Type.Object({ choices: Type.Array(Type.Object({ delta: Type.Object({ reasoning_details: Type.Unknown() }) })) }),
	Type.Object({ choices: Type.Array(Type.Object({ finish_reason: Type.String() })) }),
	Type.Object({ usage: Type.Unknown() }),
]);
