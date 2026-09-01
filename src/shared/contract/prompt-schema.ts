import { Type, type Static } from "@sinclair/typebox";

// Canonical Prompt contract shared by Character definitions and Conversation
// Participants. Keeping one schema object preserves identical wire behavior
// while preventing the two contracts from drifting apart: every consumer —
// transport schemas, domain seams, and the pure compiler — references this
// declaration instead of restating the five Prompt channels.
export const promptChannels = Type.Object({
	systemInstruction: Type.String(),
	identity: Type.String(),
	scenario: Type.String(),
	exampleDialogue: Type.String(),
	postHistoryInstruction: Type.String(),
});

export type PromptChannels = Static<typeof promptChannels>;
