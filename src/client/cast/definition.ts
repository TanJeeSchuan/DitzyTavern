import type { ParticipantPrompt } from "../conversation";

export const emptyPrompt = (): ParticipantPrompt => ({
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
});

export interface AdHocDraft {
	name: string;
	prompt: ParticipantPrompt;
	openingsText: string;
}

export const emptyAdHocDraft: AdHocDraft = {
	name: "",
	prompt: emptyPrompt(),
	openingsText: "",
};

// The shared conversion keeps Cast openings identical to Character Library
// openings (the trimming variant is the deliberate single behavior).
export { openingsFromText, openingsToText } from "../lib/openings";

export const promptFields: Array<{
	key: keyof ParticipantPrompt;
	label: string;
}> = [
	{ key: "systemInstruction", label: "System Instruction" },
	{ key: "identity", label: "Identity" },
	{ key: "scenario", label: "Scenario" },
	{ key: "exampleDialogue", label: "Example Dialogue" },
	{ key: "postHistoryInstruction", label: "Post-History Instruction" },
];

