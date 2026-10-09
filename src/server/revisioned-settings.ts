import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { guardRevision, type CurrentByAggregate } from "./revision";

export const SETTINGS_ID = 1;

export class InvalidSettingsError extends Error {
	readonly outcome = "invalid" as const;
	readonly details = { reason: this.message };

	override name = "InvalidSettingsError";
}

type SettingsTable<Row> = SQLiteTable & { id: AnySQLiteColumn; revision: AnySQLiteColumn; $inferSelect: Row; $inferInsert: Partial<Row> };

export const createRevisionedSettings = <Row extends { id: number; revision: number }, Payload extends CurrentByAggregate["settings"]>(
	database: Database,
	table: SettingsTable<Row>,
	project: (row: Row) => Payload,
) => {
	const db = drizzle(database);
	const row = () => {
		// @approved
		//  SAFETY: every settings table gives all columns but id a default, so the singleton row inserts from its id alone.
		db.insert(table).values({ id: SETTINGS_ID } as never).onConflictDoNothing().run();
		// @approved
		//  SAFETY: the table's own select shape is Row.
		return db.select().from(table).where(eq(table.id, SETTINGS_ID)).get() as Row;
	};
	const get = () => project(row());
	const commit = (expectedRevision: number, patch: Partial<Row>) => database.transaction(() => {
		const { revision } = row();
		guardRevision("settings", expectedRevision, { revision }, get);
		db.update(table).set({ ...patch, revision: revision + 1 }).where(eq(table.id, SETTINGS_ID)).run();
		return get();
	}).immediate();
	return { row, get, commit };
};
