import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import type { Lorebook, LoreEntryFields } from "../../shared/contract/lorebook";
import { executeLorebookCommand, importNativeLorebook, importSillyTavernLorebook, listLorebooks } from "./library";

describe("SillyTavern Lorebook import", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	test("warns about macros in explicit secondary fields and preserves them literally", () => {
		const result = importSillyTavernLorebook(database, {
			data: {
				name: "Imported",
				entries: [{
					comment: "Entry",
					content: "Content",
					key: ["keyword"],
					requireAny: ["{{user}}"],
					requireAll: ["{{char}}"],
					excludeAny: ["{{random}}"],
					excludeAll: ["{{scenario}}"],
				}],
			},
		});

		expect(result.warnings).toContain("Entry 1 contains unsupported macros; they remain literal.");
		expect(result.book.entries[0]).toMatchObject({
			requireAny: ["{{user}}"],
			requireAll: ["{{char}}"],
			excludeAny: ["{{random}}"],
			excludeAll: ["{{scenario}}"],
		});
	});
});

describe("Lorebook entry resequencing", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => database.close());

	const fields = (title: string): LoreEntryFields => ({
		title,
		content: `${title} content`,
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
	});

	const asBook = (applied: Lorebook | { deleted: number }): Lorebook => {
		if (!("entries" in applied)) throw new Error("The Lorebook entry command deleted the book.");
		return applied;
	};

	test("reorders into an occupied position and compacts after a delete", () => {
		const book = importNativeLorebook(database, {
			name: "World",
			description: "",
			entries: ["Alpha", "Beta", "Gamma"].map(fields),
		});
		expect(listLorebooks(database)).toEqual([
			{ id: book.id, name: "World", description: "", revision: 0, entryCount: 3 },
		]);

		// The last entry's target position is still held by an unmoved row, so
		// the renumber must move the scope aside before assigning final slots.
		const reordered = asBook(executeLorebookCommand(database, {
			type: "reorder-entry",
			bookId: book.id,
			entryId: book.entries[2].id,
			expectedRevision: 0,
			toPosition: 1,
		}));
		expect(reordered.entries.map(({ title, position }) => [title, position])).toEqual([
			["Gamma", 1],
			["Alpha", 2],
			["Beta", 3],
		]);

		const compacted = asBook(executeLorebookCommand(database, {
			type: "delete-entry",
			bookId: book.id,
			entryId: reordered.entries[1].id,
			expectedRevision: reordered.revision,
		}));
		expect(compacted.entries.map(({ title, position }) => [title, position])).toEqual([
			["Gamma", 1],
			["Beta", 2],
		]);
		expect(listLorebooks(database)).toEqual([
			{ id: book.id, name: "World", description: "", revision: 2, entryCount: 2 },
		]);
	});
});
