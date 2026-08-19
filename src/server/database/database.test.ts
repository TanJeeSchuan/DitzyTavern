import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database";

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
      database.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
      ).all(),
    ).toHaveLength(1);
  });

  test("does not apply a migration more than once", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ditzytavern-test-"));
    const path = join(directory, "test.sqlite");
    const database = openDatabase({ path, migrationsDirectory });
    const reopened = openDatabase({ path, migrationsDirectory });

    expect(
      database.query("SELECT count(*) AS count FROM __drizzle_migrations").get(),
    ).toEqual({ count: 1 });

    database.close();
    reopened.close();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(directory, { recursive: true, force: true });
        return;
      } catch {
        await Bun.sleep(100);
      }
    }
    throw new Error("Failed to remove test database directory");
  });
});
