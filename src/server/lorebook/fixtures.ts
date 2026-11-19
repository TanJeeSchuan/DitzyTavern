import type { LoreEntryFields } from "../../shared/contract/lorebook";

export const loreEntry = (overrides: Partial<LoreEntryFields> = {}): LoreEntryFields => ({
	title: "Entry",
	content: "The fact.",
	keywords: [],
	semanticTriggers: [],
	matchOperator: "or",
	always: false,
	requireAny: [],
	requireAll: [],
	excludeAny: [],
	excludeAll: [],
	caseSensitive: false,
	wholeWord: true,
	keywordMode: "literal",
	regexFlags: "",
	priority: 0,
	enabled: true,
	...overrides,
});
