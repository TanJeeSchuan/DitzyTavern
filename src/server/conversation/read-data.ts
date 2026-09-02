// ==[HUMAN APPROVED]== The narrow Conversation-scoped structured data read. The full snapshot
// walks every per-Chat data row, but deliberate detail reads (Import
// Details provenance) load only the entries they need, on demand, through
// this seam instead of opening the data tables themselves. The seam is
// vocabulary-free: namespace and key strings pass through uninterpreted, so
// the owning domain (the SillyTavern import adapter, etc.) keeps deciding
// their meaning.

import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray } from "drizzle-orm";
import { chatDataTable, chatTable } from "../database/schema";
import { connectConversationDatabase } from "./internal";
import type {
	ConversationDataEntry,
	ConversationDataRead,
	ConversationDataReadFilter,
} from "./types";

const toDataEntry = (row: {
	namespace: string;
	key: string;
	value: string;
}): ConversationDataEntry => ({
	namespace: row.namespace,
	key: row.key,
	value: row.value,
});

// ==[HUMAN APPROVED]== Reads the Conversation's name and the Conversation-scoped data entries,
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
		.from(chatTable)
		.where(eq(chatTable.id, conversationId))
		.get();
	if (conversation === undefined) return undefined;

	const conditions = [eq(chatDataTable.chat_id, conversationId)];
	if (filter.namespace !== undefined) {
		conditions.push(eq(chatDataTable.namespace, filter.namespace));
	}
	if (filter.keys !== undefined && filter.keys.length > 0) {
		conditions.push(inArray(chatDataTable.key, filter.keys));
	}
	const rows = db
		.select()
		.from(chatDataTable)
		.where(and(...conditions))
		.orderBy(asc(chatDataTable.namespace), asc(chatDataTable.key))
		.all();

	return {
		name: conversation.name,
		entries: rows.map(toDataEntry),
	};
}
