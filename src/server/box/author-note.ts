import type { Box } from "./contract";

// @approved
//  The Chat-wide Author Note (ADR-0048). Lore scanning, Semantic Trigger
// judging and Memory extraction never read it.
export const authorNoteBox = {
	advance: { run: async ({ setup }) => ({ items: setup.trim() === "" ? [] : [{ text: setup, priority: 0, pinned: true }] }) },
} satisfies Box<string>;
