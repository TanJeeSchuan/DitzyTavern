import { describeSetup, type BoxDescriptor } from "@/box-sdk/shared";
import { initialWorldClockSetup, worldClockRecord, worldClockSetup } from "./contract";

export default {
	id: "world-clock", sdk: 1, label: "World Clock", role: "system", startsEnabled: false, instructions: "",
	setup: describeSetup(worldClockSetup, initialWorldClockSetup),
	record: worldClockRecord,
	decision: {
		summary: "Reads how much time passes and the weather in each passage.",
		description: "Choose a Decision Model to advance each Chat's World Clock from what its passages say. Without one, the clock stays where it is.",
		off: "The clock stays where it is",
		context: "Each passage is read with the Message before it.",
	},
} satisfies BoxDescriptor;
