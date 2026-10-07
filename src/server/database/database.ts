import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

export interface OpenDatabaseOptions {
	path?: string;
}

const defaultDatabasePath = join(process.cwd(), "data", "ditzytavern.sqlite");
const defaultMigrationsDirectory = join(import.meta.dir, "migrations");

export function openDatabase(options: OpenDatabaseOptions = {}): Database {
	const path = options.path ?? defaultDatabasePath;

	if (path !== ":memory:") {
		mkdirSync(dirname(path), { recursive: true });
	}

	const database = new Database(path, { create: true });

	try {
		database.exec("PRAGMA foreign_keys = ON");
		database.exec("PRAGMA busy_timeout = 5000");
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}

export function initializeDatabase(
	database: Database,
	migrationsDirectory = defaultMigrationsDirectory,
): void {
	const fresh = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'prompt_preset'").get() === null;
	database.exec("PRAGMA journal_mode = WAL");
	migrate(drizzle(database), { migrationsFolder: migrationsDirectory });
	if (fresh) database.transaction(() => {
		database.run("UPDATE prompt_preset_block SET position = position + 1 WHERE preset_id = (SELECT id FROM prompt_preset WHERE is_default = 1) AND reference = 'model-post-history-instruction'");
		database.run("INSERT INTO prompt_preset_block (preset_id, position, reference, role) SELECT h.preset_id, h.position + 1, 'author-note', 'system' FROM prompt_preset_block h JOIN prompt_preset p ON p.id = h.preset_id WHERE p.is_default = 1 AND h.reference = 'history'");
	}).immediate();
}

export function openInitializedDatabase(
	options: OpenDatabaseOptions = {},
	migrationsDirectory = defaultMigrationsDirectory,
): Database {
	const database = openDatabase(options);
	try {
		initializeDatabase(database, migrationsDirectory);
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}
