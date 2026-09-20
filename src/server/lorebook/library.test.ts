import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { importSillyTavernLorebook } from "./library";

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
