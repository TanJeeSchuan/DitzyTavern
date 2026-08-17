import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const migrationFilename = /^(\d+)_([a-z0-9_]+)\.sql$/;

interface AppliedMigration {
  version: number;
}

interface Migration {
  version: number;
  name: string;
  sql: string;
}

export function runMigrations(
  database: Database,
  migrationsDirectory: string,
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT
  `);

  const migrations = loadMigrations(migrationsDirectory);
  const appliedVersions = new Set(
    database
      .query<AppliedMigration, []>(
        "SELECT version FROM schema_migrations ORDER BY version",
      )
      .all()
      .map(({ version }) => version),
  );
  const insertMigration = database.query(
    "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
  );

  const applyMigration = database.transaction((migration: Migration) => {
    database.exec(migration.sql);
    insertMigration.run(migration.version, migration.name);
  });

  for (const migration of migrations) {
    if (!appliedVersions.has(migration.version)) {
      applyMigration(migration);
    }
  }
}

function loadMigrations(migrationsDirectory: string): Migration[] {
  const migrations = readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => {
      const match = migrationFilename.exec(entry.name);
      if (!match) {
        throw new Error(`Invalid migration filename: ${entry.name}`);
      }

      return {
        version: Number(match[1]),
        name: match[2],
        sql: readFileSync(join(migrationsDirectory, entry.name), "utf8"),
      };
    })
    .sort((left, right) => left.version - right.version);

  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1].version === migrations[index].version) {
      throw new Error(`Duplicate migration version: ${migrations[index].version}`);
    }
  }

  return migrations;
}
