import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { openDatabase } from "./database";
import { runMigrations } from "./migrate";

const migrationsDirectory = join(import.meta.dir, "migrations");
const openDatabases: Database[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    database.close();
  }
});

describe("openDatabase", () => {
  test("configures SQLite and applies migrations", () => {
    const database = openDatabase({ path: ":memory:", migrationsDirectory });
    openDatabases.push(database);

    expect(
      database.query("PRAGMA foreign_keys").get() as { foreign_keys: number },
    ).toEqual({ foreign_keys: 1 });
    expect(
      database.query("PRAGMA busy_timeout").get() as { timeout: number },
    ).toEqual({ timeout: 5000 });
    expect(
      database.query("SELECT version, name FROM schema_migrations").all(),
    ).toEqual([{ version: 1, name: "initial" }]);
  });

  test("does not apply a migration more than once", () => {
    const database = openDatabase({ path: ":memory:", migrationsDirectory });
    openDatabases.push(database);

    runMigrations(database, migrationsDirectory);

    expect(
      database.query("SELECT count(*) AS count FROM schema_migrations").get(),
    ).toEqual({ count: 1 });
  });
});
