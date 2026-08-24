import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

export interface OpenDatabaseOptions {
	path?: string;
	migrationsDirectory?: string;
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
		database.exec("PRAGMA journal_mode = WAL");
		database.exec("PRAGMA busy_timeout = 5000");
		migrate(drizzle(database), {
			migrationsFolder:
				options.migrationsDirectory ?? defaultMigrationsDirectory,
		});
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}

// Runs a query against the default connection when no database is injected,
// closing only the connection this call opened. An async query keeps its
// connection open until the returned promise settles, so staged uploads can
// stream and preview against the same migration-backed connection; an
// injected database is never closed here.
export function withDatabase<T>(
	database: Database | undefined,
	query: (connection: Database) => T,
): T {
	const connection = database ?? openDatabase();
	let result: T;
	try {
		result = query(connection);
	} catch (error) {
		if (!database) connection.close();
		throw error;
	}
	if (!database && result instanceof Promise) {
		// SAFETY: the promise settles with the exact type the query declared;
		// the finally hook only defers the connection close until settlement.
		return result.finally(() => connection.close()) as T;
	}
	if (!database) {
		connection.close();
	}
	return result;
}
