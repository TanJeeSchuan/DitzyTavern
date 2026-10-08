import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	executeConversationCommand,
	createConversation,
	readConversationSummary,
	readSelectedHistory,
	readConversationData,
	loadMessageRows,
	deriveMessageSwipeEligibility,
} from "../conversation";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { syncMemorySources } from "../memory";
import { observeConversationWrites } from "../conversation";
import { ConversationNotFoundError } from "../conversation";
import type {
	ConversationCommand,
	ConversationSummary,
	ConversationCreationInput,
	ConversationDataEntry,
	AuthorStampSnapshot,
	HistoricalControlSnapshot,
	MessageSwipeEligibility,
} from "../conversation";

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
): TestConversationSnapshot {
	const summary = executeConversationCommand(module, command);
	return requireSnapshot(module, summary.id);
}

export function requireSnapshot(
	module: Database,
	conversationId: number,
): TestConversationSnapshot {
	const snapshot = readTestConversationSnapshot(module, conversationId);
	if (snapshot === undefined) {
		throw new ConversationNotFoundError(conversationId);
	}
	return snapshot;
}

export interface TestConversationVariant {
 id: number;
 position: number;
 content: string;
 timestamp: string;
 selected: boolean;
 data: ConversationDataEntry[];
}
export interface TestConversationMessage {
 id: number;
 position: number;
 timestamp: string;
 author: AuthorStampSnapshot | null;
 historicalContext: HistoricalControlSnapshot | null;
 swipe: MessageSwipeEligibility;
 variants: TestConversationVariant[];
 data: ConversationDataEntry[];
}
export interface TestConversationSnapshot extends ConversationSummary {
 messages: TestConversationMessage[];
 data: ConversationDataEntry[];
}
export function readTestConversationSnapshot(database: Database, conversationId: number): TestConversationSnapshot | undefined {
 const summary = readConversationSummary(database, conversationId);
 if (summary === undefined) return undefined;
 const rows = loadMessageRows(drizzle(database), conversationId, { variantData: true, messageData: true });
 const path = new Map(readSelectedHistory(database, conversationId)!.messages.map((message) => [message.id, message]));
 return {
  ...summary,
  data: readConversationData(database, conversationId)!.entries,
  messages: rows.messages.map((message) => {
   const identity = path.get(message.id)!;
   return {
    id: message.id, position: message.position, timestamp: message.timestamp,
    author: identity.author, historicalContext: identity.historicalContext,
    swipe: deriveMessageSwipeEligibility(summary.playable, identity.historicalContext, summary.cast.map((participant) => participant.id)),
    data: rows.messageData.get(message.id) ?? [],
    variants: (rows.variantsByMessage.get(message.id) ?? []).map((variant) => ({
     id: variant.id, position: variant.position, content: variant.content,
     timestamp: variant.timestamp, selected: variant.selected,
     data: rows.variantData.get(variant.id) ?? [],
    })),
   };
  }),
 };
}
export function createConversationWithHistory(database: Database, input: ConversationCreationInput): TestConversationSnapshot {
 const conversation = createConversation(database, input);
 return requireSnapshot(database, conversation.id);
}
