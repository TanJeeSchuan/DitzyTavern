import { describeSetup, type BoxDescriptor } from "@/box-sdk/shared";
import { authorNoteSetup } from "./contract";

export default {
	id: "author-note", sdk: 1, label: "Author Note", summary: "Adds the standing note you write for every Generation in this Chat.", role: "system", startsEnabled: true, instructions: "",
	block: { description: "Uses the Author Note saved in this Chat. Edit its text in the Author Note panel.", source: "This Chat" },
	setup: describeSetup(authorNoteSetup, ""),
} satisfies BoxDescriptor;
