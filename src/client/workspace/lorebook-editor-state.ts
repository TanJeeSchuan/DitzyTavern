import type { Lorebook } from "../lorebook-library";
import type { LoreEntry, LoreEntryFields } from "../../shared/contract/lorebook";
import { reduceDraft, type DraftEvent, type DraftSession, type Revisioned } from "../lib/revisioned-draft";

export const blankEntry = (): LoreEntryFields => ({
	title: "", content: "", keywords: [], semanticTriggers: [], matchOperator: "or", always: false,
	requireAny: [], requireAll: [], excludeAny: [], excludeAll: [], caseSensitive: false, wholeWord: true,
	keywordMode: "literal", regexFlags: "", priority: 0, enabled: true,
});
export const fieldsOf = ({ id: _id, position: _position, ...entry }: LoreEntry): LoreEntryFields => entry;
export const sameEntry = (left: LoreEntryFields, right: LoreEntryFields) => JSON.stringify(left) === JSON.stringify(right);
export interface BookFields {
	name: string;
	description: string;
}
const sameBook = (left: BookFields, right: BookFields) => left.name === right.name && left.description === right.description;
export const bookFieldsOf = (book: Lorebook): Revisioned<BookFields> => ({ value: { name: book.name, description: book.description }, revision: book.revision });
export const entryFieldsOf = (book: Lorebook, entryId: number | null): Revisioned<LoreEntryFields> => {
	const entry = book.entries.find((candidate) => candidate.id === entryId);
	return { value: entry === undefined ? blankEntry() : fieldsOf(entry), revision: book.revision };
};
export type LeaveIntent = { type: "library" } | { type: "entry"; id: number | null };
export interface BookDeleteConfirmation {
	name: string;
	detail: string;
}
export type LorebookEditorDialog =
	| { type: "leave"; intent: LeaveIntent }
	| { type: "book-delete"; confirmation: BookDeleteConfirmation }
	| { type: "entry-delete" };
// @approved
//  The book's name and description and the selected entry are two revisioned
// drafts against the book copy each started from; `book` is the newest copy
// the editor has seen, which lists the entries.
export interface LorebookEditorState {
	book: Lorebook | null;
	bookDraft: DraftSession<BookFields> | null;
	entryId: number | null;
	entryDraft: DraftSession<LoreEntryFields> | null;
	dialog: LorebookEditorDialog | null;
	notice: string | null;
}
export const initialEditorState = (): LorebookEditorState => ({ book: null, bookDraft: null, entryId: null, entryDraft: null, dialog: null, notice: null });
export const draftValue = <T>(session: DraftSession<T> | null, fallback: T): T => session === null ? fallback : session.status === "clean" ? session.base.value : session.mine;
/** @approved Edits that no in-flight save carries. */
export const unsaved = <T>(session: DraftSession<T> | null) =>
	session !== null && (session.status === "dirty" || session.status === "conflict" || (session.status === "saving" && session.edited));
const opened = <T>(server: Revisioned<T>): DraftSession<T> => ({ status: "clean", base: server });
const selectEntry = (state: LorebookEditorState, id: number | null): LorebookEditorState =>
	state.book === null ? state : { ...state, entryId: id, entryDraft: opened(entryFieldsOf(state.book, id)) };
// @approved
//  A newer copy reaches both drafts: each follows it while untouched, or while
// the value it edits is unchanged there.
const observe = (state: LorebookEditorState, book: Lorebook): LorebookEditorState => state.book !== null && state.book.revision > book.revision ? state : {
	...state,
	book,
	bookDraft: reduceDraft(state.bookDraft, { type: "observed", server: bookFieldsOf(book) }, sameBook),
	entryDraft: reduceDraft(state.entryDraft, { type: "observed", server: entryFieldsOf(book, state.entryId) }, sameEntry),
};
// @approved
//  This editor's own enable toggle changed the selected entry's saved copy
// exactly as it changes the draft, so the draft keeps following that copy.
const toggled = (session: DraftSession<LoreEntryFields> | null, enabled: boolean): DraftSession<LoreEntryFields> | null => {
	if (session === null || session.status === "saving") return session;
	if (session.status === "conflict") return { ...session, mine: { ...session.mine, enabled } };
	const base = { ...session.base, value: { ...session.base.value, enabled } };
	return session.status === "clean" ? { status: "clean", base } : { status: "dirty", base, mine: { ...session.mine, enabled } };
};
export type EditorAction =
	| { type: "reset" }
	| { type: "loaded"; book: Lorebook }
	| { type: "refreshed"; book: Lorebook }
	| { type: "book-draft"; event: DraftEvent<BookFields> }
	| { type: "entry-draft"; event: DraftEvent<LoreEntryFields>; entryId?: number | null }
	| { type: "entry-selected"; id: number | null }
	| { type: "dialog-opened"; dialog: LorebookEditorDialog }
	| { type: "dialog-closed" }
	| { type: "notice"; notice: string | null }
	| { type: "discard" }
	| { type: "keep-mine" }
	| { type: "applied"; book: Lorebook; enabled?: boolean; notice: string | null };
export function reduceLorebookEditor(state: LorebookEditorState, action: EditorAction): LorebookEditorState {
	switch (action.type) {
		case "reset": return initialEditorState();
		case "loaded": return selectEntry({ ...initialEditorState(), book: action.book, bookDraft: opened(bookFieldsOf(action.book)) }, action.book.entries[0]?.id ?? null);
		case "refreshed": return state.book?.id !== action.book.id ? reduceLorebookEditor(state, { type: "loaded", book: action.book }) : observe(state, action.book);
		case "book-draft": return { ...state, bookDraft: reduceDraft(state.bookDraft, action.event, sameBook) };
		case "entry-draft": {
			// @approved
			//  A saved new entry becomes the selected one, while the draft that
			// created it is still the selected draft.
			const session = state.entryDraft;
			const claimed = session?.status === "saving" && action.event.type === "saved" && session.submitted === action.event.submitted;
			if (!claimed || action.entryId === undefined || session?.status !== "saving") return { ...state, entryDraft: reduceDraft(session, action.event, sameEntry) };
			// @approved
			//  What arrived while a new entry saved was read without its id, so the
			// saved entry is measured against the newest book's copy of it, or its
			// absence there when it was deleted meanwhile.
			const newest = state.book === null ? session.seen : entryFieldsOf(state.book, action.entryId);
			return { ...state, entryId: action.entryId, entryDraft: reduceDraft({ ...session, seen: newest }, action.event, sameEntry) };
		}
		case "entry-selected": return selectEntry(state, action.id);
		case "dialog-opened": return { ...state, dialog: action.dialog };
		case "dialog-closed": return { ...state, dialog: null };
		case "notice": return { ...state, notice: action.notice };
		case "discard": {
			// @approved
			//  The discarded drafts start again from the newest book the editor has seen.
			const discarded = {
				...state,
				bookDraft: reduceDraft(state.bookDraft, { type: "discarded" }, sameBook),
				entryDraft: reduceDraft(state.entryDraft, { type: "discarded" }, sameEntry),
				notice: null,
			};
			return state.book === null ? discarded : observe(discarded, state.book);
		}
		case "keep-mine": return {
			...state,
			bookDraft: reduceDraft(state.bookDraft, { type: "kept-mine" }, sameBook),
			entryDraft: reduceDraft(state.entryDraft, { type: "kept-mine" }, sameEntry),
		};
		case "applied": {
			const next = action.enabled === undefined ? state : { ...state, entryDraft: toggled(state.entryDraft, action.enabled) };
			return { ...observe(next, action.book), notice: action.notice };
		}
	}
}
