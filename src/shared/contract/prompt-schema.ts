import { Type } from "@sinclair/typebox";

// Canonical prompt contract shared by Character definitions and Conversation
// Participants. Keeping one schema object preserves identical wire behavior
// while preventing the two contracts from drifting apart.
export const participantPrompt = Type.Object({
	systemInstruction: Type.String(),
	identity: Type.String(),
	scenario: Type.String(),
	exampleDialogue: Type.String(),
	postHistoryInstruction: Type.String(),
});
