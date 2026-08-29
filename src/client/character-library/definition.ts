import type {
	CharacterPrompt,
	CharacterSnapshot,
} from "../character-library";
import { openingsToText } from "../lib/openings";

export interface Drafts {
	name: string;
	prompt: CharacterPrompt;
	openingsText: string;
}

export const emptyPrompt: CharacterPrompt = {
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
};

export const emptyDrafts: Drafts = {
	name: "",
	prompt: emptyPrompt,
	openingsText: "",
};

// The shared conversion keeps Character Library openings identical to Cast
// openings (the trimming variant is the deliberate single behavior).
export { openingsFromText, openingsToText } from "../lib/openings";

export const draftsOf = (character: CharacterSnapshot): Drafts => ({
	name: character.name,
	prompt: character.prompt,
	openingsText: openingsToText(character.openings),
});

export const promptFields: Array<{
	key: keyof CharacterPrompt;
	label: string;
}> = [
	{ key: "systemInstruction", label: "System Instruction" },
	{ key: "identity", label: "Identity" },
	{ key: "scenario", label: "Scenario" },
	{ key: "exampleDialogue", label: "Example Dialogue" },
	{ key: "postHistoryInstruction", label: "Post-History Instruction" },
];

