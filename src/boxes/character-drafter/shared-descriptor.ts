import type { BoxDescriptor } from "@/box-sdk/shared";

export default {
	id: "character-drafter",
	sdk: 2,
	label: "Character Drafter",
	summary: "Drafts a Definition for anyone in the story from what the Chat says about them.",
	role: "system",
	startsEnabled: true,
	prompt: false,
	instructions: "",
} satisfies BoxDescriptor;
