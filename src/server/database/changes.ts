import type { Database } from "bun:sqlite";

// @approved
//  The database announces its own changes, so no writer has to: SQLite counts
// every row this connection changes, foreign-key cascades included, and bumps
// `data_version` when another connection commits, as a Box with its own
// handle can. A ticker compares the pair and announces one change per tick
// that moved it. A rolled-back write still moves the count; the reads it
// triggers revalidate unchanged.
type Listener = { readonly hear: (seq: number) => void; readonly close: () => void };
type Feed = { mark: string; seq: number; readonly listeners: Set<Listener> };
const feeds = new WeakMap<Database, Feed>();

const markOf = (database: Database) => {
	const { changes } = database.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()!; // @approved The aggregate always answers one row.
	const { data_version } = database.query<{ data_version: number }, []>("PRAGMA data_version").get()!; // @approved The pragma always answers one row.
	return `${changes}:${data_version}`;
};

export const watchDatabaseChanges = (database: Database, intervalMs = 100) => {
	const feed: Feed = { mark: markOf(database), seq: 0, listeners: new Set() };
	feeds.set(database, feed);
	const timer = setInterval(() => {
		const mark = markOf(database);
		if (mark === feed.mark) return;
		feed.mark = mark;
		feed.seq += 1;
		for (const listener of feed.listeners) listener.hear(feed.seq);
	}, intervalMs);
	return () => {
		clearInterval(timer);
		feeds.delete(database);
		for (const listener of feed.listeners) listener.close();
	};
};

/** @approved A listener hears the current change at once, then each later one, and is closed when the watch stops. */
export const subscribeDatabaseChanges = (database: Database, hear: (seq: number) => void, close: () => void) => {
	const feed = feeds.get(database);
	if (feed === undefined) {
		close();
		return () => {};
	}
	const listener = { hear, close };
	feed.listeners.add(listener);
	hear(feed.seq);
	return () => { feed.listeners.delete(listener); };
};

// @approved
//  A write no reader re-reads on its own: a Generation checkpoint, whose
// output readers follow on the Generation's stream. It is left out of the
// next announcement unless an earlier write is already waiting to be
// announced, which then carries it along.
export const withoutAnnouncing = <T>(database: Database, write: () => T): T => {
	const feed = feeds.get(database);
	if (feed === undefined) return write();
	const pending = markOf(database) !== feed.mark;
	const result = write();
	if (!pending) feed.mark = markOf(database);
	return result;
};
