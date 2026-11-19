import { Type, type Static, type TSchema } from "@sinclair/typebox";

/** @approved What the code agent's `run` tool takes: one piece of JavaScript. */
export const codeAgentRunInput = Type.Object({ code: Type.String() }, { additionalProperties: false });
/** @approved What the code agent's `submit` tool takes: the draft, checked against the schema its caller declared. */
export const codeAgentSubmitInput = <Draft extends TSchema>(draft: Draft) => Type.Object({ draft: Type.Unsafe<Static<Draft>>(draft) }, { additionalProperties: false });

/** @approved One run tool call's code, result and one-line summary. */
export const codeAgentActivity = Type.Object({ summary: Type.String(), code: Type.String(), output: Type.String() });
export type CodeAgentActivity = Readonly<Static<typeof codeAgentActivity>>;
