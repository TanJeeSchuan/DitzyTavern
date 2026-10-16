import type { BoxDescriptor } from "@/box-sdk/shared";
import { moodRecord } from "./shared";

export default {
	id: "mood", sdk: 1, label: "Mood", role: "system", startsEnabled: false, instructions: "Scene mood:",
	record: moodRecord,
	decision: {
		summary: "Reads the mood each passage leaves the scene in.",
		description: "Choose a Decision Model to follow each Chat's mood from what its passages say. Without one, the mood stays where it is.",
		off: "The mood stays where it is",
		context: "Each passage is read with the Message before it.",
	},
} satisfies BoxDescriptor;
