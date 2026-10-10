import { boxSetups } from "../../shared/contract/box";
import type { Box } from "./contract";

// @approved
//  The Chat-wide Author Note (ADR-0048). Lore scanning, Semantic Trigger
// judging and Memory extraction never read it.
export const authorNoteBox = {
	setup: { schema: boxSetups.properties["author-note"], initial: "" },
	advance: { run: ({ setup }) => ({ items: setup.trim() === "" ? [] : [{ text: setup }] }) },
} satisfies Box<string>;
