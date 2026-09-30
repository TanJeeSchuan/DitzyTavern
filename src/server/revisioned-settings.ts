import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";

export const SETTINGS_ID = 1;

export class InvalidSettingsError extends Error {
	override name = "InvalidSettingsError";
}
export class StaleSettingsError<Payload> extends Error {
	override name = "StaleSettingsError";
	constructor(readonly expectedRevision: number, readonly actualRevision: number, readonly currentSettings: Payload) {
		super(`Expected settings revision ${expectedRevision}, but the current revision is ${actualRevision}.`);
	}
}

type SettingsTable<Row> = SQLiteTable & { id: AnySQLiteColumn; revision: AnySQLiteColumn; $inferSelect: Row; $inferInsert: Partial<Row> };

export const createRevisionedSettings = <Row extends { id: number; revision: number }, Payload>(database: Database, table: SettingsTable<Row>, project: (row: Row) => Payload) => {
	const db = drizzle(database);
	const row = () => {
		// ==[HUMAN APPROVED]== SAFETY: every settings table gives all columns but id a default, so the singleton row inserts from its id alone.
		db.insert(table).values({ id: SETTINGS_ID } as never).onConflictDoNothing().run();
		// ==[HUMAN APPROVED]== SAFETY: the table's own select shape is Row.
		return db.select().from(table).where(eq(table.id, SETTINGS_ID)).get() as Row;
	};
	const get = () => project(row());
	const commit = (expectedRevision: number, patch: Partial<Row>) => database.transaction(() => {
		const { revision } = row();
		if (revision !== expectedRevision) throw new StaleSettingsError(expectedRevision, revision, get());
		db.update(table).set({ ...patch, revision: revision + 1 }).where(eq(table.id, SETTINGS_ID)).run();
		return get();
	}).immediate();
	return { row, get, commit };
};
