import { executeConversationCommand, readConversationSnapshot } from "../conversation";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { syncMemorySources } from "../memory";
import { observeConversationWrites } from "../conversation";
import { ConversationNotFoundError } from "../conversation";
import type { ConversationCommand, ConversationSnapshot } from "../conversation";

export function openObservedDatabase(): Database {
	const database = openInitializedDatabase({ path: ":memory:" });
	observeConversationWrites(database, syncMemorySources);
	return database;
}

/**
 * ==[HUMAN APPROVED]== Test-fixture seam for suites that assert on Messages
 * after an edit. Mutations return the Conversation header only, so this applies
 * the command through the ordinary public seam and then re-reads the full
 * snapshot. It exists so tests keep exercising `execute` rather than a parallel
 * commit path, and it is therefore absent from the public barrel and every HTTP
 * route. Product code must read history through the paginated seam instead of
 * materializing whole Conversations.
 */
export function applyCommand(
	module: Database,
	command: ConversationCommand,
): ConversationSnapshot {
	const summary = executeConversationCommand(module, command);
	return requireSnapshot(module, summary.id);
}

export function requireSnapshot(
	module: Database,
	conversationId: number,
): ConversationSnapshot {
	const snapshot = readConversationSnapshot(module, conversationId);
	if (snapshot === undefined) {
		throw new ConversationNotFoundError(conversationId);
	}
	return snapshot;
}
