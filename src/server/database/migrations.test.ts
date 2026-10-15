import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

test("retires populated memory tables with catchup references", async () => {
	const database = new Database(":memory:");
	try {
		database.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE memory_catchup_run (id INTEGER PRIMARY KEY);
			CREATE TABLE memory_collection (
				variant_id INTEGER PRIMARY KEY,
				catchup_run_id INTEGER REFERENCES memory_catchup_run(id)
			);
			INSERT INTO memory_catchup_run VALUES (1);
			INSERT INTO memory_collection VALUES (1, 1);
			CREATE TABLE message_variant_data (namespace TEXT, key TEXT);
			CREATE TABLE active_generation (memory_activation_json TEXT);
			CREATE TABLE generation_replay (memory_activation_json TEXT);
		`);

		const migration = await Bun.file(new URL("./migrations/0025_first_solo.sql", import.meta.url)).text();
		for (const statement of migration.split("--> statement-breakpoint")) database.exec(statement);

		expect(database.query("SELECT name FROM sqlite_schema WHERE name IN ('memory_collection', 'memory_catchup_run')").all()).toEqual([]);
	} finally {
		database.close();
	}
});
