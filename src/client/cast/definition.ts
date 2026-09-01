import type { PromptChannels } from "../../shared/contract/prompt-schema";
import { emptyPromptChannels } from "../../shared/definition";

export interface AdHocDraft {
	name: string;
	prompt: PromptChannels;
	openingsText: string;
}

export const emptyAdHocDraft: AdHocDraft = {
	name: "",
	prompt: emptyPromptChannels(),
	openingsText: "",
};

// ==[HUMAN APPROVED]== The shared conversion keeps Cast openings identical to Character Library
// openings (the trimming variant is the deliberate single behavior).
export { openingsFromText, openingsToText } from "../lib/openings";
