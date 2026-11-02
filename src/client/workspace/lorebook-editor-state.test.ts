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

	test("a new entry saved while an unrelated book edit arrived settles against the entry it created", () => {
		const created = { ...blankEntry(), title: "Created" };
		const selected = reduceLorebookEditor(loaded(), { type: "entry-selected", id: null });
		const edited = reduceLorebookEditor(selected, { type: "entry-draft", event: { type: "edited", mine: created } });
		const saving = reduceLorebookEditor(edited, { type: "entry-draft", event: { type: "save-started", submitted: created } });
		const newer: Lorebook = { ...book, name: "Renamed", revision: 3, entries: [...book.entries, { ...created, id: 8, position: 1 }] };
		const observed = reduceLorebookEditor(saving, { type: "refreshed", book: newer });
		const saved = reduceLorebookEditor(observed, { type: "entry-draft", entryId: 8, event: { type: "saved", submitted: created, saved: { value: created, revision: 2 } } });
		expect(saved.entryId).toBe(8);
		expect(saved.entryDraft).toMatchObject({ status: "clean", base: { revision: 3, value: { title: "Created" } } });
	});

	test("discard restores the newest book the editor has seen, not the copy the draft started from", () => {
		const edited = reduceLorebookEditor(loaded(), { type: "book-draft", event: { type: "edited", mine: { name: "Mine", description: "" } } });
		const changed = reduceLorebookEditor(edited, { type: "refreshed", book: { ...book, name: "Theirs", revision: 2 } });
		const discarded = reduceLorebookEditor(changed, { type: "discard" });
		expect(discarded.bookDraft).toMatchObject({ status: "clean", base: { revision: 2, value: { name: "Theirs" } } });
	});

	test("an entry deleted elsewhere while its save was in flight is not settled as saved", () => {
		const mine = { ...blankEntry(), title: "Mine" };
		const edited = reduceLorebookEditor(loaded(), { type: "entry-draft", event: { type: "edited", mine } });
		const saving = reduceLorebookEditor(edited, { type: "entry-draft", event: { type: "save-started", submitted: mine } });
		const deleted = reduceLorebookEditor(saving, { type: "refreshed", book: { ...book, revision: 3, entries: [] } });
		const saved = reduceLorebookEditor(deleted, { type: "entry-draft", entryId: 7, event: { type: "saved", submitted: mine, saved: { value: mine, revision: 2 } } });
		expect(saved.entryDraft?.status).toBe("conflict");
	});
});
