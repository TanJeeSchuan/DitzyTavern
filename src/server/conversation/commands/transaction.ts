import type { Database } from "bun:sqlite";
import { and, eq, sql } from "drizzle-orm";
import { conversationTable } from "../../database/schema";
import type { ConversationMemoryChange } from "../../../shared/contract/conversation-memory-change";
import {
	ConversationNotFoundError,
	ConversationWriteObserverMissingError,
	StaleConversationRevisionError,
} from "../errors";
import {
	connectConversationDatabase,
	type ConversationDatabase,
} from "../internal";
import { readConversationSnapshotFromConnection, readConversationSummaryFromConnection } from "../snapshot";
import type { ConversationSnapshot, ConversationSummary } from "../types";

// ==[HUMAN APPROVED]== Shared Conversation write seam: every server-owned write runs as one
// immediate SQLite transaction on a fresh Drizzle handle, advances the
// Conversation revision exactly once, and finishes with the authoritative
// summary. Deep history remains an explicit read. Command modules compose these pieces instead of hand-repeating
// the connect/bump/read scaffolding.

const revisionAdvanceSet = (lastMessageTime: string | undefined) =>
	lastMessageTime === undefined
		? { revision: sql`${conversationTable.revision} + 1` }
		: {
				revision: sql`${conversationTable.revision} + 1`,
				last_message_time: lastMessageTime,
		};

/**
 * ==[HUMAN APPROVED]== The application-installed consumer of Conversation's reported write
 * changes, registered per database. The deep Conversation module never
 * imports Memory: the composition owning each database (app.ts for the
 * application database, each test composition for its own database) installs
 * the sync here, and every committed write delivers its
 * ConversationMemoryChange through this seam. Registration is keyed by
 * database so parallel compositions in one process never observe one
 * another's writes.
 */
type ConversationWriteObserver = (
	database: Database,
	change: ConversationMemoryChange,
) => void;

const writeObservers = new WeakMap<Database, ConversationWriteObserver>();

export function observeConversationWrites(
	database: Database,
	observer: ConversationWriteObserver,
): void {
	writeObservers.set(database, observer);
}

/**
 * ==[HUMAN APPROVED]== Run one Conversation write as a single immediate transaction. The
 * work reports the change it made through the transaction-scoped reporter and
 * the observer runs as this wrapper's last statement, so Memory sees exactly
 * the state this transaction commits, with the writes still uncommitted to
 * other transactions — identical ordering to the pre-refactor per-handler
 * calls without the deep module ever calling Memory itself.
 */
export function runConversationTransaction<T>(
	database: Database,
	work: (
		db: ConversationDatabase,
		reportChange: (change: ConversationMemoryChange) => void,
	) => T,
): T {
	let reported: ConversationMemoryChange | undefined;
	return database
		.transaction(() => {
			const result = work(
				connectConversationDatabase(database),
				(change) => {
					if (reported !== undefined) {
						throw new Error(
							"One Conversation write reports exactly one change record.",
						);
					}
					reported = change;
				},
			);
			if (reported !== undefined) {
				const observer = writeObservers.get(database);
				if (observer === undefined) throw new ConversationWriteObserverMissingError();
				observer(database, reported);
			}
			return result;
		})
		.immediate();
}

/** ==[HUMAN APPROVED]== Run one coherent Conversation read without reserving SQLite's write lock. */
export function runConversationReadTransaction<T>(
	database: Database,
	work: (db: ConversationDatabase) => T,
): T {
	return database
		.transaction(() => work(connectConversationDatabase(database)))
		.deferred();
}

/**
 * ==[HUMAN APPROVED]== Advance the Conversation revision inside an open transaction and return
 * the post-write summary, throwing the typed not-found error when the
 * Conversation has disappeared mid-transaction. The optional write time
 * mirrors the caller's Message timestamp into last_message_time; omitting
 * it leaves the column untouched (removals and server-side commits).
 */
export function advanceConversationRevision(
	db: ConversationDatabase,
	conversationId: number,
	lastMessageTime?: string,
): ConversationSummary {
	db.update(conversationTable)
		.set(revisionAdvanceSet(lastMessageTime))
		.where(eq(conversationTable.id, conversationId))
		.run();
	return requireConversationSummary(db, conversationId);
}

export function requireConversationSummary(
	db: ConversationDatabase,
	conversationId: number,
): ConversationSummary {
	const summary = readConversationSummaryFromConnection(db, conversationId);
	if (summary === undefined) {
		throw new ConversationNotFoundError(conversationId);
	}
	return summary;
}

/**
 * ==[HUMAN APPROVED]== Advance the Conversation revision only while it still matches
 * expectedRevision, throwing the typed stale error otherwise. The stale
 * error's reported current revision is caller-owned: command execution
 * reports the revision read at transaction start, while the acceptance
 * seams report the pre-bump revision as expectedRevision + 1.
 */
export function advanceConversationRevisionGuarded(
	db: ConversationDatabase,
	conversationId: number,
	expectedRevision: number,
	staleActualRevision: number,
	lastMessageTime?: string,
): void {
	const advanced = db
		.update(conversationTable)
		.set(revisionAdvanceSet(lastMessageTime))
		.where(
			and(
				eq(conversationTable.id, conversationId),
				eq(conversationTable.revision, expectedRevision),
			),
		)
		.returning({ revision: conversationTable.revision })
		.get();
	if (advanced === undefined) {
		throw new StaleConversationRevisionError(
			expectedRevision,
			staleActualRevision,
		);
	}
}

/** ==[HUMAN APPROVED]== Read the authoritative snapshot or throw the typed not-found error. */
export function requireConversationSnapshot(
	db: ConversationDatabase,
	conversationId: number,
): ConversationSnapshot {
	const snapshot = readConversationSnapshotFromConnection(db, conversationId);
	if (snapshot === undefined) {
		throw new ConversationNotFoundError(conversationId);
	}
	return snapshot;
}
