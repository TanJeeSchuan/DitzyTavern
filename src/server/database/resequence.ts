import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

type ResequenceDatabase = ReturnType<typeof drizzle>;

/** @approved The pair every resequenced table shares: a row identity and a dense 1-based `position` scoped by a parent row. */
export interface ResequencedTable {
	readonly id: AnySQLiteColumn;
	readonly position: AnySQLiteColumn;
}

// @approved
//  One re-sequence for every "`position` is a dense 1-based order under a
//  UNIQUE (scope, position) index" table, replacing the per-module offset and
//  negative-position tricks. SQLite forbids a qualified column in a SET
//  target, so the assignment names `position` as an identifier while
//  expressions may use the table-qualified column. The negating pass moves
//  the whole scope out of the positive range first, so the final dense
//  assignment can never collide with a row that has not moved yet.
export const resequence = (
	db: ResequenceDatabase,
	table: ResequencedTable,
	scopeColumn: AnySQLiteColumn,
	scopeId: number,
	orderedIds: readonly number[],
): void => {
	db.run(sql`UPDATE ${table} SET ${sql.identifier("position")} = -${table.position} WHERE ${scopeColumn} = ${scopeId}`);
	orderedIds.forEach((id, index) => {
		db.run(sql`UPDATE ${table} SET ${sql.identifier("position")} = ${index + 1} WHERE ${table.id} = ${id}`);
	});
};
