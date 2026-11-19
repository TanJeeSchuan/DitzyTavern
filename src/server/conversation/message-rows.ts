import { and, asc, eq, getTableColumns, inArray, lte, type SQL } from "drizzle-orm";
import { messageTable, messageVariantDataTable, messageVariantTable } from "../database/schema";
import { groupRowsByNumber, type ConversationDatabase } from "./internal";
import type { ConversationDataEntry } from "./types";
import { liveVariantContent } from "./generation-checkpoint";

export const toDataEntry = (row: { namespace: string; key: string; value: string }): ConversationDataEntry => ({ namespace: row.namespace, key: row.key, value: row.value });

interface MessageRowsRequest {
	ids?: readonly number[];
	upToPosition?: number;
}

export function loadMessageRows(db: ConversationDatabase, conversationId: number, request: MessageRowsRequest = {}) {
	const messages = request.ids?.length === 0 ? [] : db.select().from(messageTable).where(and(
		eq(messageTable.conversation_id, conversationId),
		request.ids === undefined ? undefined : inArray(messageTable.id, [...request.ids]),
		request.upToPosition === undefined ? undefined : lte(messageTable.position, request.upToPosition),
	)).orderBy(asc(messageTable.position)).all();
	const ids = messages.map((message) => message.id);
	const variants = ids.length === 0 ? [] : db.select({ ...getTableColumns(messageVariantTable), content: liveVariantContent }).from(messageVariantTable).where(and(
		inArray(messageVariantTable.message_id, ids),
		eq(messageVariantTable.selected, true),
	)).orderBy(asc(messageVariantTable.message_id), asc(messageVariantTable.position)).all();
	return { messages, variants };
}

export function loadVariantDataRows(db: ConversationDatabase, ids: readonly number[], filter?: SQL): Map<number, ConversationDataEntry[]> {
 if (ids.length === 0) return new Map();
 const rows = db.select().from(messageVariantDataTable).where(and(inArray(messageVariantDataTable.message_variant_id, [...ids]), filter))
  .orderBy(asc(messageVariantDataTable.message_variant_id), asc(messageVariantDataTable.namespace), asc(messageVariantDataTable.key)).all();
 return groupRowsByNumber(rows, (row) => row.message_variant_id, toDataEntry);
}
