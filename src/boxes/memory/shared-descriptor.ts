import type { BoxDescriptor } from "@/box-sdk/shared";
import { memoryRecord } from "./contract";

export default {
	id: "memory", sdk: 1, label: "Memory", summary: "Remembers what passages establish and recalls it when a Generation is assembled.", role: "system", startsEnabled: true, instructions: "",
	block: { description: "Uses Conversation Memories recalled when a Generation is assembled.", source: "Conversation Memories" },
	record: memoryRecord,
	decision: {
		summary: "Judges the Memories extraction proposes and scores saved Memories for recall.",
		description: "Choose a Decision Model to judge each Message's proposed Memories and to pick the ones a scene needs. Without one, Memory remembers and recalls nothing.",
		off: "Memory remembers nothing",
		context: "Each Message is read with up to four Messages before it.",
	},
} satisfies BoxDescriptor;
