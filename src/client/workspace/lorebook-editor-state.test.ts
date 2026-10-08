import { describe, expect, test } from "bun:test";
import type { Lorebook } from "../lorebook-library";
import { editedSince, initialEditorState, reduceLorebookEditor, type LorebookEditorState } from "./lorebook-editor-state";

const book = { id: 1, name: "Old", description: "", revision: 1, entries: [] } as unknown as Lorebook;
const loaded = () => reduceLorebookEditor(initialEditorState(), { type: "loaded", book });

describe("lorebook save edit detection", () => {
	test("a save is not superseded when the server normalizes the submitted name", () => {
		const edited = reduceLorebookEditor(loaded(), { type: "book-edited", draft: { name: " New ", description: "" } });
		const submitted = edited;
		const saved = reduceLorebookEditor(edited, {
			type: "applied", book: { ...book, name: "New", revision: 2 }, submitted, notice: null,
		});
		expect(editedSince(saved, submitted)).toBe(false);
	});

	test("an edit made after submitting marks the save as superseded", () => {
		const submitted = reduceLorebookEditor(loaded(), { type: "book-edited", draft: { name: "New", description: "" } });
		const typedAgain = reduceLorebookEditor(submitted, { type: "book-edited", draft: { name: "Newer", description: "" } });
		expect(editedSince(typedAgain, submitted)).toBe(true);
	});

	test("selecting another entry after submitting marks the save as superseded", () => {
		const withEntries = { ...book, entries: [{ id: 7, position: 0, title: "a" }, { id: 8, position: 1, title: "b" }] } as unknown as Lorebook;
		const submitted: LorebookEditorState = { ...initialEditorState(), book: withEntries, entryId: 7 };
		const moved = reduceLorebookEditor(submitted, { type: "entry-selected", id: 8 });
		expect(editedSince(moved, submitted)).toBe(true);
	});
});
