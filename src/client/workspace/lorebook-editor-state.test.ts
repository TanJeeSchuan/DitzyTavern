import { describe, expect, test } from "bun:test";
import type { Lorebook } from "../lorebook-library";
import { blankEntry, draftValue, initialEditorState, reduceLorebookEditor } from "./lorebook-editor-state";

const book: Lorebook = { id: 1, name: "Old", description: "", revision: 1, entries: [{ ...blankEntry(), title: "Entry", id: 7, position: 0 }] };
const loaded = () => reduceLorebookEditor(initialEditorState(), { type: "loaded", book });

describe("lorebook drafts", () => {
	test("a save is not superseded when the server normalizes the submitted name", () => {
		const submitted = { name: " New ", description: "" };
		const edited = reduceLorebookEditor(loaded(), { type: "book-draft", event: { type: "edited", mine: submitted } });
		const saving = reduceLorebookEditor(edited, { type: "book-draft", event: { type: "save-started", submitted } });
		const saved = reduceLorebookEditor(saving, { type: "book-draft", event: { type: "saved", submitted, saved: { value: { name: "New", description: "" }, revision: 2 } } });
		expect(saved.bookDraft?.status).toBe("clean");
		expect(draftValue(saved.bookDraft, submitted).name).toBe("New");
	});

	test("this editor's enable toggle keeps an edited entry draft following the saved entry", () => {
		const edited = reduceLorebookEditor(loaded(), { type: "entry-draft", event: { type: "edited", mine: { ...blankEntry(), title: "Edited" } } });
		const toggledBook: Lorebook = { ...book, revision: 2, entries: [{ ...book.entries[0]!, enabled: false }] };
		const toggled = reduceLorebookEditor(edited, { type: "applied", book: toggledBook, enabled: false, notice: null });
		expect(toggled.entryDraft).toMatchObject({ status: "dirty", base: { revision: 2 }, mine: { title: "Edited", enabled: false } });
	});
});
