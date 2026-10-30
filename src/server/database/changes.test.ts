import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subscribeDatabaseChanges, watchDatabaseChanges, withoutAnnouncing } from "./changes";

const TICK = 5;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const watched = (path = ":memory:") => {
	const database = new Database(path);
	database.run("PRAGMA foreign_keys = ON");
	database.run("CREATE TABLE IF NOT EXISTS book (id INTEGER PRIMARY KEY)");
	database.run("CREATE TABLE IF NOT EXISTS page (id INTEGER PRIMARY KEY, book INTEGER REFERENCES book(id) ON DELETE CASCADE)");
	const stop = watchDatabaseChanges(database, TICK);
	const heard: number[] = [];
	let closed = false;
	subscribeDatabaseChanges(database, (seq) => heard.push(seq), () => { closed = true; });
	cleanups.push(() => { stop(); database.close(); });
	return { database, heard, stop, closed: () => closed };
};
const ticks = () => Bun.sleep(TICK * 4);

test("a listener hears the current change at once, then one change per tick that wrote", async () => {
	const { database, heard } = watched();
	expect(heard).toEqual([0]);
	await ticks();
	expect(heard).toEqual([0]);
	database.run("INSERT INTO book VALUES (1)");
	database.run("INSERT INTO page VALUES (1, 1)");
	await ticks();
	expect(heard).toEqual([0, 1]);
	database.run("DELETE FROM book");
	await ticks();
	expect(heard).toEqual([0, 1, 2]);
});

test("a commit through another connection is announced", async () => {
	const folder = mkdtempSync(join(tmpdir(), "ditzy-changes-"));
	cleanups.push(() => rmSync(folder, { recursive: true, force: true }));
	const { heard } = watched(join(folder, "changes.sqlite"));
	const other = new Database(join(folder, "changes.sqlite"));
	other.run("INSERT INTO book VALUES (1)");
	other.close();
	await ticks();
	expect(heard).toEqual([0, 1]);
});

test("an unannounced write stays out of the feed unless a write before it is still waiting", async () => {
	const { database, heard } = watched();
	withoutAnnouncing(database, () => database.run("INSERT INTO book VALUES (1)"));
	await ticks();
	expect(heard).toEqual([0]);
	database.run("INSERT INTO book VALUES (2)");
	withoutAnnouncing(database, () => database.run("INSERT INTO book VALUES (3)"));
	await ticks();
	expect(heard).toEqual([0, 1]);
});

test("stopping the watch closes its listeners", () => {
	const { stop, closed } = watched();
	stop();
	expect(closed()).toBe(true);
});
