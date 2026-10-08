import type { LoreEntryFields } from "../../shared/contract/lorebook";

type EntryListKey = keyof Pick<LoreEntryFields, "keywords" | "semanticTriggers" | "requireAny" | "requireAll" | "excludeAny" | "excludeAll">;

const entryMatchFields = [
	["keywords", "Keywords"],
	["semanticTriggers", "Semantic triggers"],
] as const satisfies readonly (readonly [EntryListKey, string])[];

const entryConditionFields = [
	["requireAny", "Require any"],
	["requireAll", "Require all"],
	["excludeAny", "Exclude any"],
	["excludeAll", "Exclude all"],
] as const satisfies readonly (readonly [EntryListKey, string])[];

const parseOperator = (value: string): LoreEntryFields["matchOperator"] => value === "and" ? "and" : "or";

// @approved
//  Expressions are newline-delimited in the editor. Commas are valid expression
// content (especially in quantified regular expressions), so they cannot be a
// list separator.
const splitList = (value: string): string[] => value.split(/\r?\n/).filter((part) => part.length > 0);
const joinList = (value: string[]): string => value.join("\n");

export {
	entryConditionFields,
	entryMatchFields,
	joinList,
	parseOperator,
	splitList,
};
export type { EntryListKey };
