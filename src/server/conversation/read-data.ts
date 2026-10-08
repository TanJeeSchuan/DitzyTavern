import { toDataEntry } from "./message-rows";
// @approved
//  The narrow Conversation-scoped structured data read. The full snapshot
// walks every per-Chat data row, but deliberate detail reads (Import
// Details provenance) load only the entries they need, on demand, through
// this seam instead of opening the data tables themselves. The seam is
// vocabulary-free: namespace and key strings pass through uninterpreted, so
// the owning domain (the SillyTavern import adapter, etc.) keeps deciding
// their meaning.

import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray } from "drizzle-orm";
import { conversationDataTable, conversationTable } from "../database/schema";
import { connectConversationDatabase } from "./internal";
import type {
	ConversationDataRead,
	ConversationDataReadFilter,
} from "./types";

// @approved
//  Reads the Conversation's name and the Conversation-scoped data entries,
// optionally narrowed to one namespace and/or a key set. The Conversation
// must exist; if it does not, the read returns undefined. A present
// Conversation with no matching entries returns an empty entries array, so
// "no data under this filter" is a clean empty read rather than a failure.
export function readConversationData(
	database: Database,
	conversationId: number,
	filter: ConversationDataReadFilter = {},
): ConversationDataRead | undefined {
	const db = connectConversationDatabase(database);
	const conversation = db
		.select()
		.from(conversationTable)
		.where(eq(conversationTable.id, conversationId))
		.get();
	if (conversation === undefined) return undefined;

	const conditions = [eq(conversationDataTable.conversation_id, conversationId)];
	if (filter.namespace !== undefined) {
		conditions.push(eq(conversationDataTable.namespace, filter.namespace));
	}
	if (filter.keys !== undefined && filter.keys.length > 0) {
		conditions.push(inArray(conversationDataTable.key, filter.keys));
	}
	const rows = db
		.select()
		.from(conversationDataTable)
		.where(and(...conditions))
		.orderBy(asc(conversationDataTable.namespace), asc(conversationDataTable.key))
		.all();

	return {
		name: conversation.name,
		entries: rows.map(toDataEntry),
	};
}
