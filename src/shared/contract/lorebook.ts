import { Type, type Static } from "@sinclair/typebox";
import { numericWire } from "./wire";
import { invalidOutcome, notFoundOutcome } from "./outcomes";
import { conversationConflict } from "./conversation-schema";

export const loreMatchOperator = Type.Union([Type.Literal("and"), Type.Literal("or")]);
export const loreKeywordMode = Type.Union([Type.Literal("literal"), Type.Literal("regex")]);
export const loreAttachmentScope = Type.Union([
	Type.Literal("controlled-participant"),
	Type.Literal("cast"),
	Type.Literal("chat"),
]);
export type LoreAttachmentScope = Static<typeof loreAttachmentScope>;

export const loreAttachmentCommandBody = Type.Union([
	Type.Object({ type: Type.Literal("attach-character"), characterId: Type.Integer(), bookId: Type.Integer(), expectedRevision: Type.Integer(), scope: Type.Union([Type.Literal("controlled-participant"), Type.Literal("cast")]), enabled: Type.Optional(Type.Boolean()) }),
	Type.Object({ type: Type.Literal("attach-participant"), participantId: Type.Integer(), bookId: Type.Integer(), expectedRevision: Type.Integer(), scope: Type.Union([Type.Literal("controlled-participant"), Type.Literal("cast")]), enabled: Type.Optional(Type.Boolean()) }),
	Type.Object({ type: Type.Literal("attach-chat"), conversationId: Type.Integer(), bookId: Type.Integer(), expectedRevision: Type.Integer(), enabled: Type.Optional(Type.Boolean()) }),
	Type.Object({ type: Type.Literal("detach-character"), characterId: Type.Integer(), bookId: Type.Integer(), expectedRevision: Type.Integer(), scope: Type.Union([Type.Literal("controlled-participant"), Type.Literal("cast")]) }),
	Type.Object({ type: Type.Literal("detach-participant"), participantId: Type.Integer(), bookId: Type.Integer(), expectedRevision: Type.Integer(), scope: Type.Union([Type.Literal("controlled-participant"), Type.Literal("cast")]) }),
	Type.Object({ type: Type.Literal("detach-chat"), conversationId: Type.Integer(), bookId: Type.Integer(), expectedRevision: Type.Integer() }),
	Type.Object({ type: Type.Literal("save-settings"), conversationId: Type.Integer(), expectedRevision: Type.Integer(), scanDepth: Type.Integer(), allowance: Type.Integer() }),
]);
export type LoreAttachmentCommand = Static<typeof loreAttachmentCommandBody>;
export const loreAttachmentCommandResponse = Type.Object({ outcome: Type.Literal("applied") });
export const loreAttachmentQuery = Type.Object({ conversationId: numericWire });
export const loreAttachmentState = Type.Object({
	conversationId: Type.Integer(),
	revision: Type.Integer(),
	scanDepth: Type.Integer({ minimum: 0 }),
	allowance: Type.Integer({ minimum: 0 }),
	attachments: Type.Array(Type.Object({
		id: Type.Integer(),
		owner: Type.Union([Type.Literal("character"), Type.Literal("participant"), Type.Literal("conversation")]),
		ownerId: Type.Integer(),
		bookId: Type.Integer(),
		scope: loreAttachmentScope,
		enabled: Type.Boolean(),
		eligible: Type.Boolean(),
		reason: Type.Union([Type.Literal("eligible"), Type.Literal("disabled"), Type.Literal("not-in-cast"), Type.Literal("not-controlled")]),
	})),
});
export type LoreAttachmentState = Static<typeof loreAttachmentState>;

export const lorebookOwnerAttachmentQuery = Type.Object({ ownerId: numericWire });
export const lorebookOwnerAttachmentState = Type.Object({
	owner: Type.Union([Type.Literal("character"), Type.Literal("participant")]),
	ownerId: Type.Integer(),
	revision: Type.Integer(),
	attachments: Type.Array(Type.Object({
		id: Type.Integer(),
		bookId: Type.Integer(),
		scope: Type.Union([Type.Literal("controlled-participant"), Type.Literal("cast")]),
		enabled: Type.Boolean(),
	})),
});
export type LorebookOwnerAttachmentState = Static<typeof lorebookOwnerAttachmentState>;
// ==[HUMAN APPROVED]== Only the two Character-owned Lore attachment commands still
// produce a Lorebook attachment conflict; the Conversation-owned commands
// recover through the Conversation conflict shape (conversation-schema), so
// the conversation state members left this union with their machinery.
export const loreAttachmentConflict = Type.Object({
	outcome: Type.Literal("conflict"),
	reason: Type.Literal("stale-revision"),
	expectedRevision: Type.Integer(),
	actualRevision: Type.Integer(),
	currentState: lorebookOwnerAttachmentState,
});

// ==[HUMAN APPROVED]== The Lorebook attachment command's conflict response: Character-owned
// commands recover through the Lorebook attachment conflict above, while
// the Conversation-owned commands recover through the canonical Conversation
// conflict shape.
export const loreAttachmentCommandConflict = Type.Union([loreAttachmentConflict, conversationConflict]);

export const lorebookAttachmentImpact = Type.Object({
	bookId: Type.Integer(),
	attachments: Type.Array(Type.Object({
		id: Type.Integer(),
		owner: Type.Union([Type.Literal("character"), Type.Literal("participant"), Type.Literal("conversation")]),
		ownerId: Type.Integer(),
		ownerName: Type.String(),
		scope: loreAttachmentScope,
		enabled: Type.Boolean(),
	})),
});
export type LorebookAttachmentImpact = Static<typeof lorebookAttachmentImpact>;

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

export const lorebookImportApplied = Type.Object({
	outcome: Type.Literal("applied"),
	book: lorebook,
	warnings: Type.Array(Type.String()),
});
export const lorebookCommandApplied = Type.Object({ outcome: Type.Literal("applied"), book: lorebook });
export const lorebookDeleted = Type.Object({ outcome: Type.Literal("deleted"), bookId: Type.Integer() });
export const lorebookCommandResponse = Type.Union([lorebookCommandApplied, lorebookDeleted]);
export const loreMatchTestBody = Type.Object({ bookId: Type.Integer(), writing: Type.String() });
const loreMatchTestCondition = Type.Object({ matched: Type.Boolean(), matchedExpressions: Type.Array(Type.String()), missingExpressions: Type.Array(Type.String()) });
const loreMatchTestSemantic = Type.Object({
	available: Type.Boolean(),
	matched: Type.Boolean(),
	threshold: Type.Union([Type.Number(), Type.Null()]),
	matches: Type.Array(Type.Object({ trigger: Type.String(), score: Type.Number() })),
	fallbackReason: Type.Optional(Type.String()),
});
const loreMatchTestEntry = Type.Object({
	bookId: Type.Integer(),
	bookName: Type.String(),
	entryId: Type.Integer(),
	title: Type.String(),
	active: Type.Boolean(),
	skipped: Type.Boolean(),
	fallback: Type.Boolean(),
	primary: loreMatchTestCondition,
	secondary: Type.Object({ requireAny: loreMatchTestCondition, requireAll: loreMatchTestCondition, excludeAny: loreMatchTestCondition, excludeAll: loreMatchTestCondition }),
	semantic: loreMatchTestSemantic,
	reasons: Type.Array(Type.String()),
});
export const loreMatchTestResponse = Type.Object({
	mode: Type.Union([Type.Literal("semantic"), Type.Literal("keyword-fallback"), Type.Literal("none")]),
	fallbackReason: Type.Optional(Type.String()),
	scan: Type.Array(Type.Object({ id: Type.Union([Type.Integer(), Type.Null()]), content: Type.String() })),
	matches: Type.Array(loreMatchTestEntry),
});
export type LoreMatchTestResponse = Static<typeof loreMatchTestResponse>;
export const lorebookConflict = Type.Object({
	outcome: Type.Literal("conflict"),
	reason: Type.Literal("stale-revision"),
	expectedRevision: Type.Integer(),
	actualRevision: Type.Integer(),
	currentBook: lorebook,
});

export const lorebookListResponse = Type.Object({ books: Type.Array(lorebookSummary) });
export const bookIdParams = Type.Object({ bookId: numericWire });

export type LorebookListResponse = Static<typeof lorebookListResponse>;

// ==[HUMAN APPROVED]== The Lorebook command families' modeled error unions: the composed
// 409/404/422 envelopes each family declares, so the client decodes an error
// body against exactly the union its route models.
export const lorebookCommandErrors = Type.Union([
	lorebookConflict,
	notFoundOutcome,
	invalidOutcome,
]);

export const loreAttachmentCommandErrors = Type.Union([
	loreAttachmentConflict,
	notFoundOutcome,
	invalidOutcome,
]);
