import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { runMigrations } from "./migrate";

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
    runMigrations(
      database,
      options.migrationsDirectory ?? defaultMigrationsDirectory,
    );
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
