import { Type, type Static } from "@sinclair/typebox";
import { numericWire } from "./wire";
import type { SillyTavernJsonValue } from "./prompt-preset";

export const loreMatchOperator = Type.Union([Type.Literal("and"), Type.Literal("or")]);
export const loreKeywordMode = Type.Union([Type.Literal("literal"), Type.Literal("regex")]);

export const loreEntryFields = Type.Object({
	title: Type.String(),
	content: Type.String(),
	keywords: Type.Array(Type.String()),
	semanticTriggers: Type.Array(Type.String()),
	matchOperator: loreMatchOperator,
	always: Type.Boolean(),
	requireAny: Type.Array(Type.String()),
	requireAll: Type.Array(Type.String()),
	excludeAny: Type.Array(Type.String()),
	excludeAll: Type.Array(Type.String()),
	caseSensitive: Type.Boolean(),
	wholeWord: Type.Boolean(),
	keywordMode: loreKeywordMode,
	regexFlags: Type.String(),
	semanticThreshold: Type.Union([Type.Number(), Type.Null()]),
	priority: Type.Integer(),
	enabled: Type.Boolean(),
});
export type LoreEntryFields = Static<typeof loreEntryFields>;

export const loreEntry = Type.Intersect([
	Type.Object({ id: Type.Integer(), position: Type.Integer() }),
	loreEntryFields,
]);
export type LoreEntry = Static<typeof loreEntry>;

export const lorebook = Type.Object({
	id: Type.Integer(),
	name: Type.String(),
	description: Type.String(),
	revision: Type.Integer(),
	entries: Type.Array(loreEntry),
});
export type Lorebook = Static<typeof lorebook>;

export const lorebookSummary = Type.Object({
	id: Type.Integer(),
	name: Type.String(),
	description: Type.String(),
	revision: Type.Integer(),
	entryCount: Type.Integer(),
});
export type LorebookSummary = Static<typeof lorebookSummary>;

const createCommand = Type.Object({
	type: Type.Literal("create"),
	name: Type.String(),
	description: Type.Optional(Type.String()),
});
const updateBookCommand = Type.Object({
	type: Type.Literal("update-book"),
	bookId: Type.Integer(),
	expectedRevision: Type.Integer(),
	name: Type.String(),
	description: Type.String(),
});
const duplicateCommand = Type.Object({
	type: Type.Literal("duplicate"),
	bookId: Type.Integer(),
	expectedRevision: Type.Integer(),
	name: Type.Optional(Type.String()),
});
const deleteCommand = Type.Object({
	type: Type.Literal("delete"),
	bookId: Type.Integer(),
	expectedRevision: Type.Integer(),
});
const saveEntryCommand = Type.Object({
	type: Type.Literal("save-entry"),
	bookId: Type.Integer(),
	entryId: Type.Optional(Type.Integer()),
	expectedRevision: Type.Integer(),
	entry: loreEntryFields,
});
const deleteEntryCommand = Type.Object({
	type: Type.Literal("delete-entry"),
	bookId: Type.Integer(),
	entryId: Type.Integer(),
	expectedRevision: Type.Integer(),
});
const reorderEntryCommand = Type.Object({
	type: Type.Literal("reorder-entry"),
	bookId: Type.Integer(),
	entryId: Type.Integer(),
	expectedRevision: Type.Integer(),
	toPosition: Type.Integer(),
});
const setEntryEnabledCommand = Type.Object({
	type: Type.Literal("set-entry-enabled"),
	bookId: Type.Integer(),
	entryId: Type.Integer(),
	expectedRevision: Type.Integer(),
	enabled: Type.Boolean(),
});

export const lorebookCommandBody = Type.Union([
	createCommand,
	updateBookCommand,
	duplicateCommand,
	deleteCommand,
	saveEntryCommand,
	deleteEntryCommand,
	reorderEntryCommand,
	setEntryEnabledCommand,
]);
export type LorebookCommand = Static<typeof lorebookCommandBody>;

export const nativeLorebook = Type.Object({
	name: Type.String(),
	description: Type.String(),
	entries: Type.Array(loreEntryFields),
});
export type NativeLorebook = Static<typeof nativeLorebook>;
export const sillyTavernLorebookImportBody = Type.Object({ source: Type.Unknown() });
export type SillyTavernLorebookImportBody = { source: SillyTavernJsonValue };

export const lorebookImportApplied = Type.Object({
	outcome: Type.Literal("applied"),
	book: lorebook,
	warnings: Type.Array(Type.String()),
});
export const lorebookCommandApplied = Type.Object({ outcome: Type.Literal("applied"), book: lorebook });
export const lorebookDeleted = Type.Object({ outcome: Type.Literal("deleted"), bookId: Type.Integer() });
export const lorebookCommandResponse = Type.Union([lorebookCommandApplied, lorebookDeleted]);
export const lorebookConflict = Type.Object({
	outcome: Type.Literal("conflict"),
	reason: Type.Literal("stale-revision"),
	expectedRevision: Type.Integer(),
	actualRevision: Type.Integer(),
	currentBook: lorebook,
});

export const lorebookListResponse = Type.Object({ books: Type.Array(lorebookSummary) });
export const lorebookResponse = lorebook;
export const bookIdParams = Type.Object({ bookId: numericWire });
export const entryIdParams = Type.Object({ bookId: numericWire, entryId: numericWire });

export type LorebookListResponse = Static<typeof lorebookListResponse>;
