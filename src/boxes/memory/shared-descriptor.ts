import type { BoxDescriptor } from "@/box-sdk/shared";
import { memoryChatSettings, memoryExportInput, memoryLabels, memoryPeople, memoryRecord, memorySelectedClaims } from "./contract";

export default {
	id: "memory", sdk: 2, label: "Memory", summary: "Remembers what passages establish and recalls it when a Generation is assembled.", role: "system", startsEnabled: true, instructions: "",
	block: { description: "Uses Conversation Memories recalled when a Generation is assembled.", source: "Conversation Memories" },
	record: memoryRecord,
	values: { chat: { settings: memoryChatSettings, labels: memoryLabels } },
	exports: {
		people: { description: "The person labels Memory knows on the Chat's Selected narrative path, after its label merges.", input: memoryExportInput, output: memoryPeople },
		selectedClaims: {
			description: "Effective Claims on the Selected narrative path, with resolved people and the Message that holds each Claim.",
			input: memoryExportInput,
			output: memorySelectedClaims,
		},
	},
	decision: {
		summary: "Judges the Memories extraction proposes and scores saved Memories for recall.",
		description: "Choose a Decision Model to judge each Message's proposed Memories and to pick the ones a scene needs. Without one, Memory remembers and recalls nothing.",
		off: "Memory remembers nothing",
		context: "Each Message is read with up to four Messages before it.",
	},
} satisfies BoxDescriptor;
