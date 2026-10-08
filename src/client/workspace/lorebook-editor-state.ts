import type { Lorebook } from "../lorebook-library";
import type { LoreEntry, LoreEntryFields } from "../../shared/contract/lorebook";

export const blankEntry = (): LoreEntryFields => ({
	title: "", content: "", keywords: [], semanticTriggers: [], matchOperator: "or", always: false,
	requireAny: [], requireAll: [], excludeAny: [], excludeAll: [], caseSensitive: false, wholeWord: true,
	keywordMode: "literal", regexFlags: "", priority: 0, enabled: true,
});
export const fieldsOf = ({ id: _id, position: _position, ...entry }: LoreEntry): LoreEntryFields => entry;
export const sameEntry = (left: LoreEntryFields, right: LoreEntryFields) => JSON.stringify(left) === JSON.stringify(right);
export type LeaveIntent = { type: "library" } | { type: "entry"; id: number | null };
export interface LorebookEditorState {
	book: Lorebook | null;
	bookDraft: { name: string; description: string };
	entryId: number | null;
	entryDraft: LoreEntryFields;
	draftVersion: number;
	leaveIntent: LeaveIntent | null;
	bookDeleteConfirmation: { name: string; detail: string } | null;
	entryDeleteConfirmation: boolean;
	notice: string | null;
}
export const initialEditorState = (): LorebookEditorState => ({
	book: null, bookDraft: { name: "", description: "" }, entryId: null, entryDraft: blankEntry(), draftVersion: 0,
	leaveIntent: null, bookDeleteConfirmation: null, entryDeleteConfirmation: false, notice: null,
});
export const editedSince = (current: LorebookEditorState, submitted: LorebookEditorState) => current.draftVersion !== submitted.draftVersion;
export const selectEntry = (state: LorebookEditorState, id: number | null): LorebookEditorState => {
	const entry = state.book?.entries.find((entry) => entry.id === id);
	return { ...state, entryId: id, entryDraft: entry === undefined ? blankEntry() : fieldsOf(entry) };
};
export type EditorAction =
	| { type: "loaded"; book: Lorebook }
	| { type: "book-edited"; draft: LorebookEditorState["bookDraft"] }
	| { type: "entry-edited"; draft: LoreEntryFields }
	| { type: "entry-selected"; id: number | null }
	| { type: "leave-requested"; intent: LeaveIntent | null }
	| { type: "book-delete-requested"; confirmation: LorebookEditorState["bookDeleteConfirmation"] }
	| { type: "entry-delete-requested"; open: boolean }
	| { type: "notice"; notice: string | null }
	| { type: "discard" }
	| { type: "applied"; book: Lorebook; submitted: LorebookEditorState; newEntry?: boolean; enabled?: boolean; preserveBookDraft?: boolean; notice: string | null };
export function reduceLorebookEditor(state: LorebookEditorState, action: EditorAction): LorebookEditorState {
	switch (action.type) {
		case "loaded": return selectEntry({ ...initialEditorState(), book: action.book, bookDraft: action.book }, action.book.entries[0]?.id ?? null);
		case "book-edited": return { ...state, bookDraft: action.draft, draftVersion: state.draftVersion + 1 };
		case "entry-edited": return { ...state, entryDraft: action.draft, draftVersion: state.draftVersion + 1 };
		case "entry-selected": return { ...selectEntry(state, action.id), draftVersion: state.draftVersion + 1 };
		case "leave-requested": return { ...state, leaveIntent: action.intent };
		case "book-delete-requested": return { ...state, bookDeleteConfirmation: action.confirmation };
		case "entry-delete-requested": return { ...state, entryDeleteConfirmation: action.open };
		case "notice": return { ...state, notice: action.notice };
		case "discard": return state.book === null ? state : { ...selectEntry({ ...state, bookDraft: state.book, notice: null }, state.entryId), draftVersion: state.draftVersion + 1 };
		case "applied": {
			let next: LorebookEditorState = { ...state, book: action.book, notice: action.notice };
			if (!action.preserveBookDraft && state.bookDraft === action.submitted.bookDraft) next.bookDraft = action.book;
			if (state.entryDraft === action.submitted.entryDraft && state.entryId === action.submitted.entryId) {
				if (action.newEntry) next = selectEntry(next, action.book.entries.at(-1)?.id ?? null);
				else if (action.enabled !== undefined) next.entryDraft = { ...state.entryDraft, enabled: action.enabled };
			}
			return next;
		}
	}
}
