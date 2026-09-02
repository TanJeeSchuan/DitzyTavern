import type { Database } from "bun:sqlite";
import { and, eq, sql } from "drizzle-orm";
import { chatTable } from "../../database/schema";
import {
	ConversationNotFoundError,
	StaleConversationRevisionError,
} from "../errors";
import {
	connectConversationDatabase,
	type ConversationDatabase,
} from "../internal";
import { readConversationSnapshotFromConnection } from "../snapshot";
import type { ConversationSnapshot } from "../types";

// ==[HUMAN APPROVED]== Shared Conversation write seam: every server-owned write runs as one
// immediate SQLite transaction on a fresh Drizzle handle, advances the
// Conversation revision exactly once, and finishes with the authoritative
// snapshot. Command modules compose these pieces instead of hand-repeating
// the connect/bump/read scaffolding.

const revisionAdvanceSet = (lastMessageTime: string | undefined) =>
	lastMessageTime === undefined
		? { revision: sql`${chatTable.revision} + 1` }
		: {
				revision: sql`${chatTable.revision} + 1`,
				last_message_time: lastMessageTime,
		};

/** ==[HUMAN APPROVED]== Run one Conversation write as a single immediate transaction. */
export function runConversationTransaction<T>(
	database: Database,
	work: (db: ConversationDatabase) => T,
): T {
	return database
		.transaction(() => work(connectConversationDatabase(database)))
		.immediate();
}

/**
 * ==[HUMAN APPROVED]== Advance the Conversation revision inside an open transaction and return
 * the post-write snapshot, throwing the typed not-found error when the
 * Conversation has disappeared mid-transaction. The optional write time
 * mirrors the caller's Message timestamp into last_message_time; omitting
 * it leaves the column untouched (removals and server-side commits).
 */
export function advanceConversationRevision(
	db: ConversationDatabase,
	conversationId: number,
	lastMessageTime?: string,
): ConversationSnapshot {
	db.update(chatTable)
		.set(revisionAdvanceSet(lastMessageTime))
		.where(eq(chatTable.id, conversationId))
		.run();
	return requireConversationSnapshot(db, conversationId);
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
		.update(chatTable)
		.set(revisionAdvanceSet(lastMessageTime))
		.where(
			and(
				eq(chatTable.id, conversationId),
				eq(chatTable.revision, expectedRevision),
			),
		)
		.returning({ revision: chatTable.revision })
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
