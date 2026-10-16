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
	database.exec("PRAGMA journal_mode = WAL");
	migrate(drizzle(database), { migrationsFolder: migrationsDirectory });
}

// @approved
//  Tests open hundreds of in-memory databases; each one copies a migrated
// image instead of running every migration again.
const migratedImages = new Map<string, Uint8Array>();

export function openInitializedDatabase(
	options: OpenDatabaseOptions = {},
	migrationsDirectory = defaultMigrationsDirectory,
): Database {
	if (options.path === ":memory:") {
		let image = migratedImages.get(migrationsDirectory);
		if (!image) {
			const template = openDatabase(options);
			initializeDatabase(template, migrationsDirectory);
			migratedImages.set(migrationsDirectory, image = template.serialize());
			template.close();
		}
		const database = Database.deserialize(image);
		database.exec("PRAGMA foreign_keys = ON");
		return database;
	}
	const database = openDatabase(options);
	try {
		initializeDatabase(database, migrationsDirectory);
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}
