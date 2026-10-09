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
	ConversationDataEntry,
	ConversationDataRead,
	ConversationDataReadFilter,
} from "./types";

const queryBatches = <T>(values: readonly T[]): T[][] =>
	Array.from({ length: Math.ceil(values.length / 500) }, (_, index) =>
		values.slice(index * 500, (index + 1) * 500),
	);

// @approved
//  Reads the Conversation's name and the Conversation-scoped data entries,
// optionally narrowed to one namespace and/or a key set. The Conversation
// must exist; if it does not, the read returns undefined. A present
// Conversation with no matching entries returns an empty entries array, so
// "no data under this filter" is a clean empty read rather than a failure.
export const readConversationData = (
	database: Database,
	conversationId: number,
	filter: ConversationDataReadFilter = {},
): ConversationDataRead | undefined =>
	readConversationDataBatch(database, [conversationId], filter).get(conversationId);

// @approved
//  The batched form of the same read: one name read and one entry read per
//  bounded id batch instead of one Conversation at a time, so a
//  cross-Conversation search never costs a read per candidate. Conversations
//  that do not exist are absent from the result; a present Conversation with
//  no matching entries maps to an empty entries array.
export function readConversationDataBatch(
	database: Database,
	conversationIds: readonly number[],
	filter: ConversationDataReadFilter = {},
): Map<number, ConversationDataRead> {
	const db = connectConversationDatabase(database);
	const reads = new Map<number, ConversationDataRead>();
	for (const batch of queryBatches([...new Set(conversationIds)])) {
		const names = new Map(db
			.select({ id: conversationTable.id, name: conversationTable.name })
			.from(conversationTable)
			.where(inArray(conversationTable.id, batch))
			.all()
			.map((row) => [row.id, row.name] as const));
		const entries = new Map<number, ConversationDataEntry[]>();
		const rows = db
			.select()
			.from(conversationDataTable)
			.where(and(
				inArray(conversationDataTable.conversation_id, batch),
				filter.namespace === undefined ? undefined : eq(conversationDataTable.namespace, filter.namespace),
				filter.keys === undefined || filter.keys.length === 0 ? undefined : inArray(conversationDataTable.key, filter.keys),
			))
			.orderBy(asc(conversationDataTable.conversation_id), asc(conversationDataTable.namespace), asc(conversationDataTable.key))
			.all();
		for (const row of rows) entries.set(row.conversation_id, [...(entries.get(row.conversation_id) ?? []), toDataEntry(row)]);
		for (const [id, name] of names) reads.set(id, { name, entries: entries.get(id) ?? [] });
	}
	return reads;
}
