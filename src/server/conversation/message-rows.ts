import { and, asc, eq, inArray, lte, type SQL } from "drizzle-orm";
import { messageDataTable, messageTable, messageVariantDataTable, messageVariantTable } from "../database/schema";
import { groupRowsByNumber, groupVariantsByMessage, type ConversationDatabase } from "./internal";
import type { ConversationDataEntry } from "./types";

export const toDataEntry = (row: { namespace: string; key: string; value: string }): ConversationDataEntry => ({ namespace: row.namespace, key: row.key, value: row.value });

export interface MessageRowsRequest {
	ids?: readonly number[];
	upToPosition?: number;
	selectedOnly?: boolean;
	variantData?: boolean | { namespace?: string; keys?: readonly string[] };
	messageData?: boolean;
}

export function loadMessageRows(db: ConversationDatabase, conversationId: number, request: MessageRowsRequest = {}) {
	const messages = request.ids?.length === 0 ? [] : db.select().from(messageTable).where(and(
		eq(messageTable.conversation_id, conversationId),
		request.ids === undefined ? undefined : inArray(messageTable.id, [...request.ids]),
		request.upToPosition === undefined ? undefined : lte(messageTable.position, request.upToPosition),
	)).orderBy(asc(messageTable.position)).all();
	const ids = messages.map((message) => message.id);
	const variants = ids.length === 0 ? [] : db.select().from(messageVariantTable).where(and(
		inArray(messageVariantTable.message_id, ids),
		request.selectedOnly ? eq(messageVariantTable.selected, true) : undefined,
	)).orderBy(asc(messageVariantTable.message_id), asc(messageVariantTable.position)).all();
	const variantIds = variants.map((variant) => variant.id);
	const filter = request.variantData !== undefined && request.variantData !== false && request.variantData !== true ? request.variantData : undefined;
	const variantData = !request.variantData ? new Map<number, ConversationDataEntry[]>() : loadVariantDataRows(db, variantIds, and(
		filter?.namespace === undefined ? undefined : eq(messageVariantDataTable.namespace, filter.namespace),
		filter?.keys?.length ? inArray(messageVariantDataTable.key, [...filter.keys]) : undefined,
	));
	const messageData = !request.messageData || ids.length === 0 ? [] : db.select().from(messageDataTable)
		.where(inArray(messageDataTable.message_id, ids)).orderBy(asc(messageDataTable.message_id), asc(messageDataTable.namespace), asc(messageDataTable.key)).all();
	return {
		messages,
		variants,
		variantsByMessage: groupVariantsByMessage(variants, (variant) => variant),
		variantData,
		messageData: groupRowsByNumber(messageData, (row) => row.message_id, toDataEntry),
	};
}

export function loadVariantDataRows(db: ConversationDatabase, ids: readonly number[], filter?: SQL): Map<number, ConversationDataEntry[]> {
 if (ids.length === 0) return new Map();
 const rows = db.select().from(messageVariantDataTable).where(and(inArray(messageVariantDataTable.message_variant_id, [...ids]), filter))
  .orderBy(asc(messageVariantDataTable.message_variant_id), asc(messageVariantDataTable.namespace), asc(messageVariantDataTable.key)).all();
 return groupRowsByNumber(rows, (row) => row.message_variant_id, toDataEntry);
}
