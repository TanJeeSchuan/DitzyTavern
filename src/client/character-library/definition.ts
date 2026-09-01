import type { PromptChannels } from "../../shared/contract/prompt-schema";
import { emptyPromptChannels } from "../../shared/definition";
import type { CharacterSnapshot } from "../character-library";
import { openingsToText } from "../lib/openings";

export interface Drafts {
	name: string;
	prompt: PromptChannels;
	openingsText: string;
}

export const emptyDrafts: Drafts = {
	name: "",
	prompt: emptyPromptChannels(),
	openingsText: "",
};

// The shared conversion keeps Character Library openings identical to Cast
// ==[HUMAN APPROVED]== openings (the trimming variant is the deliberate single behavior).
export { openingsFromText, openingsToText } from "../lib/openings";

export const draftsOf = (character: CharacterSnapshot): Drafts => ({
	name: character.name,
	prompt: character.prompt,
	openingsText: openingsToText(character.openings),
});
