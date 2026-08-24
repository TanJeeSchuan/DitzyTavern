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

export const openingsToText = (openings: readonly string[]) =>
	openings.join("\n");

export const openingsFromText = (text: string) =>
	text.split("\n").map((line) => line.trimEnd());

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

