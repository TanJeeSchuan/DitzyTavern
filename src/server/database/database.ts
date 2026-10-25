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

/** @approved Dead space below this floor never pays for the full-file rewrite VACUUM performs. */
const DEAD_PAGE_BYTES = 32 * 1024 * 1024;

// @approved
//  One connection profile for every database this process opens. WAL with
//  synchronous=NORMAL keeps commits crash-safe without an fsync each, and a
//  64 MiB page cache covers the live set of a Chat database whose scattered
//  free pages would otherwise be re-read on every transaction.
const configureConnection = (database: Database): void => {
	database.exec("PRAGMA foreign_keys = ON");
	database.exec("PRAGMA busy_timeout = 5000");
	database.exec("PRAGMA synchronous = NORMAL");
	database.exec("PRAGMA cache_size = -65536");
	database.exec("PRAGMA mmap_size = 268435456");
	database.exec("PRAGMA temp_store = MEMORY");
};

export function openDatabase(options: OpenDatabaseOptions = {}): Database {
	const path = options.path ?? defaultDatabasePath;

	if (path !== ":memory:") {
		mkdirSync(dirname(path), { recursive: true });
	}

	const database = new Database(path, { create: true });

	try {
		configureConnection(database);
		return database;
	} catch (error) {
		database.close();
		throw error;
	}
}

// @approved
//  A migration that drops a table or a column leaves its pages on the
//  freelist, and nothing else ever shrinks the file, so a schema change used to
//  leave half of it dead space. Reclaim it once, while the process is still
//  starting and owns the only connection.
const reclaimDeadPages = (database: Database): void => {
	const pageSize = database.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 0;
	const freePages = database.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count ?? 0;
	if (pageSize * freePages < DEAD_PAGE_BYTES) return;
	database.exec("VACUUM");
	// @approved
	//  VACUUM writes its output through the WAL, which keeps that high-water
	//  mark until the process exits, so the reclaim would otherwise just move the
	//  bytes from the database file into the write-ahead log.
	database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
};

export function initializeDatabase(
	database: Database,
	migrationsDirectory = defaultMigrationsDirectory,
): void {
	database.exec("PRAGMA journal_mode = WAL");
	migrate(drizzle(database), { migrationsFolder: migrationsDirectory });
	reclaimDeadPages(database);
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
		configureConnection(database);
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
