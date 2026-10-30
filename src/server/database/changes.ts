import type { Database } from "bun:sqlite";

// @approved
//  The database announces its own changes, so no writer has to: SQLite counts
// every row this connection changes, foreign-key cascades included, and bumps
// `data_version` when another connection commits, as a Box with its own
// handle can. A ticker compares the pair and announces one change per tick
// that moved it. A rolled-back write still moves the count; the reads it
// triggers revalidate unchanged.
type Listener = { readonly hear: (seq: number) => void; readonly close: () => void };
type Mark = { changes: number; version: number };
type Feed = { mark: Mark; seq: number; readonly listeners: Set<Listener> };
const feeds = new WeakMap<Database, Feed>();

const markOf = (database: Database): Mark => ({
	changes: database.query<{ changes: number }, []>("SELECT total_changes() AS changes").get()!.changes, // @approved The aggregate always answers one row.
	version: database.query<{ data_version: number }, []>("PRAGMA data_version").get()!.data_version, // @approved The pragma always answers one row.
});
const moved = (from: Mark, to: Mark) => from.changes !== to.changes || from.version !== to.version;

const announce = (feed: Feed) => {
	feed.seq += 1;
	for (const listener of feed.listeners) listener.hear(feed.seq);
};

export const watchDatabaseChanges = (database: Database, intervalMs = 100) => {
	const feed: Feed = { mark: markOf(database), seq: 0, listeners: new Set() };
	feeds.set(database, feed);
	const timer = setInterval(() => {
		const mark = markOf(database);
		if (!moved(feed.mark, mark)) return;
		feed.mark = mark;
		announce(feed);
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

/** @approved Announces state the server keeps beside the database, such as a catch-up run starting or ending, which no row records. */
export const announceChange = (database: Database) => {
	const feed = feeds.get(database);
	if (feed !== undefined) announce(feed);
};

// @approved
//  A write no reader re-reads on its own: a Generation checkpoint, whose
// output readers follow on the Generation's stream. Its rows are left out of
// the next announcement unless an earlier write on this connection is already
// waiting to be announced, which then carries them along. Only this
// connection's count is acknowledged, so another connection's commit is still
// announced.
export const withoutAnnouncing = <T>(database: Database, write: () => T): T => {
	const feed = feeds.get(database);
	if (feed === undefined) return write();
	const pending = markOf(database).changes !== feed.mark.changes;
	const result = write();
	if (!pending) feed.mark = { ...feed.mark, changes: markOf(database).changes };
	return result;
};
