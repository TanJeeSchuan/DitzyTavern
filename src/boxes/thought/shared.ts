import { Type, type Static } from "@sinclair/typebox";

/** @approved The Thoughts block's default instructions, its whole prompt contribution. */
export const thoughtInstructions = "When a character thinks something they do not say aloud, write it inside the prose as <thought>the thought</thought>. Never restate a thought in the narration.";

// @approved
//  The Thoughts window read: each thought on the Selected narrative path,
//  oldest first. `key` is the Variant and the thought's place in it; `author`
//  is who wrote the passage.
export const thoughtRead = Type.Object({
	conversationId: Type.Integer(),
	revision: Type.Integer(),
	thoughts: Type.Array(Type.Object({ key: Type.String(), author: Type.Union([Type.Null(), Type.String()]), text: Type.String() })),
});
export type ThoughtRead = Static<typeof thoughtRead>;
