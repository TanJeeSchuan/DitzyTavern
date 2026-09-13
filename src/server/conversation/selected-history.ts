// ==[HUMAN APPROVED]== Focused selected-history read model. Generation and Macro Variable
// consumers need only the selected narrative path and, optionally, one
// namespace of Variant data; loading every alternative Variant or arbitrary
// metadata makes those reads scale with discarded history.

import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray, isNull, like, lte, max } from "drizzle-orm";
import {
	conversationDataTable,
	conversationTable,
	messageTable,
	messageVariantDataTable,
	messageVariantTable,
	participantTable,
} from "../database/schema";
import type { ConversationDatabase } from "./internal";
import { toAuthorStamp, toHistoricalContext } from "./message-read-projection";
import { runConversationTransaction } from "./commands/transaction";
import type {
	ConversationDataEntry,
	AuthorStampSnapshot,
	HistoricalControlSnapshot,
	SelectedHistoryReadRequest,
} from "./types";
import { InvalidConversationCommandError } from "./errors";

export interface SelectedHistoryVariant {
	id: number;
	position: number;
	content: string;
	data: ConversationDataEntry[];
}

export interface SelectedHistoryMessage {
	id: number;
	position: number;
	author: AuthorStampSnapshot | null;
	historicalContext: HistoricalControlSnapshot | null;
	variant: SelectedHistoryVariant | null;
}

export interface SelectedHistoryRead {
	conversationId: number;
	revision: number;
	position: number;
	initialData: ConversationDataEntry[];
	messages: SelectedHistoryMessage[];
	target?: SelectedHistoryMessage | undefined;
}

const dataEntry = (row: {
	namespace: string;
	key: string;
	value: string;
}): ConversationDataEntry => ({
	namespace: row.namespace,
	key: row.key,
	value: row.value,
});

const readSelectedHistoryFromConnection = (
	db: ConversationDatabase,
	conversationId: number,
	request: SelectedHistoryReadRequest,
): SelectedHistoryRead | undefined => {
	const conversation = db
		.select({ id: conversationTable.id, revision: conversationTable.revision })
		.from(conversationTable)
		.where(eq(conversationTable.id, conversationId))
		.get();
	if (conversation === undefined) return undefined;

	const lastPosition = db
		.select({ value: max(messageTable.position) })
		.from(messageTable)
		.where(eq(messageTable.conversation_id, conversationId))
		.get()?.value ?? 0;
	const targetRow = request.targetMessageId === undefined
		? undefined
		: db
			.select({
				id: messageTable.id,
				position: messageTable.position,
				author_participant_id: messageTable.author_participant_id,
				author_name: messageTable.author_name,
				context_human_participant_id: messageTable.context_human_participant_id,
				context_model_participant_id: messageTable.context_model_participant_id,
			})
			.from(messageTable)
			.where(and(
				eq(messageTable.id, request.targetMessageId),
				eq(messageTable.conversation_id, conversationId),
			))
			.get();
	if (request.targetMessageId !== undefined && targetRow === undefined) {
		throw new InvalidConversationCommandError(
			`Message ${request.targetMessageId} does not belong to Conversation ${conversationId}.`,
		);
	}
	const requestedPosition = request.position ?? targetRow?.position ?? lastPosition;
	if (!Number.isInteger(requestedPosition) || requestedPosition < 0) {
		throw new InvalidConversationCommandError("History position must be a non-negative integer.");
	}
	if (requestedPosition > lastPosition) {
		throw new InvalidConversationCommandError(`History position ${requestedPosition} is beyond the end of this Conversation.`);
	}
	const position = targetRow === undefined
		? requestedPosition
		: Math.min(requestedPosition, targetRow.position - 1);

	const initialConditions = [eq(conversationDataTable.conversation_id, conversationId)];
	if (request.conversationDataNamespace !== undefined) {
		initialConditions.push(eq(conversationDataTable.namespace, request.conversationDataNamespace));
	}
	if (request.conversationDataKeys !== undefined && request.conversationDataKeys.length > 0) {
		initialConditions.push(inArray(conversationDataTable.key, request.conversationDataKeys));
	}
	if (request.conversationDataKeyPrefix !== undefined) {
		initialConditions.push(like(
			conversationDataTable.key,
			`${request.conversationDataKeyPrefix}%`,
		));
	}
	const initialRows = db
		.select({
			namespace: conversationDataTable.namespace,
			key: conversationDataTable.key,
			value: conversationDataTable.value,
		})
		.from(conversationDataTable)
		.where(and(...initialConditions))
		.all();

	const messageRows = db
		.select({
			id: messageTable.id,
			position: messageTable.position,
			author_participant_id: messageTable.author_participant_id,
			author_name: messageTable.author_name,
			context_human_participant_id: messageTable.context_human_participant_id,
			context_model_participant_id: messageTable.context_model_participant_id,
		})
		.from(messageTable)
		.where(and(
			eq(messageTable.conversation_id, conversationId),
			lte(messageTable.position, position),
			...(targetRow === undefined ? [] : [lte(messageTable.position, targetRow.position - 1)]),
		))
		.orderBy(asc(messageTable.position))
		.all();
	const messageIds = [
		...messageRows.map((message) => message.id),
		...(targetRow === undefined ? [] : [targetRow.id]),
	];
	const selectedRows = messageIds.length === 0
		? []
		: db
			.select({
				messageId: messageVariantTable.message_id,
				id: messageVariantTable.id,
				position: messageVariantTable.position,
				content: messageVariantTable.content,
			})
			.from(messageVariantTable)
			.where(and(
				inArray(messageVariantTable.message_id, messageIds),
				eq(messageVariantTable.selected, true),
			))
			.orderBy(asc(messageVariantTable.message_id), asc(messageVariantTable.position))
			.all();
	const selectedIds = selectedRows.map((variant) => variant.id);
	const variantDataConditions = [
		inArray(messageVariantDataTable.message_variant_id, selectedIds),
	];
	if (request.variantDataNamespace !== undefined) {
		variantDataConditions.push(eq(messageVariantDataTable.namespace, request.variantDataNamespace));
	}
	if (request.variantDataKeys !== undefined && request.variantDataKeys.length > 0) {
		variantDataConditions.push(inArray(messageVariantDataTable.key, request.variantDataKeys));
	}
	const variantDataRows = selectedIds.length === 0
		? []
		: db
			.select({
				variantId: messageVariantDataTable.message_variant_id,
				namespace: messageVariantDataTable.namespace,
				key: messageVariantDataTable.key,
				value: messageVariantDataTable.value,
			})
			.from(messageVariantDataTable)
			.where(and(...variantDataConditions))
			.orderBy(
				asc(messageVariantDataTable.message_variant_id),
				asc(messageVariantDataTable.namespace),
				asc(messageVariantDataTable.key),
			)
			.all();
	const dataByVariant = new Map<number, ConversationDataEntry[]>();
	for (const row of variantDataRows) {
		const entries = dataByVariant.get(row.variantId) ?? [];
		entries.push(dataEntry(row));
		dataByVariant.set(row.variantId, entries);
	}
	const selectedByMessage = new Map<number, SelectedHistoryVariant>();
	for (const row of selectedRows) {
		selectedByMessage.set(row.messageId, {
			id: row.id,
			position: row.position,
			content: row.content,
			data: dataByVariant.get(row.id) ?? [],
		});
	}
	const castIds = new Set(db
		.select({ id: participantTable.id })
		.from(participantTable)
		.where(and(
			eq(participantTable.conversation_id, conversationId),
			isNull(participantTable.deleted_at),
		))
		.all()
		.map((participant) => participant.id));
	const toMessage = (message: typeof messageRows[number]): SelectedHistoryMessage => ({
		id: message.id,
		position: message.position,
		author: toAuthorStamp(message, castIds),
		historicalContext: toHistoricalContext(message),
		variant: selectedByMessage.get(message.id) ?? null,
	});

	const result: SelectedHistoryRead = {
		conversationId,
		revision: conversation.revision,
		position,
		initialData: initialRows.map(dataEntry),
		messages: messageRows.map(toMessage),
	};
	if (targetRow !== undefined) result.target = toMessage(targetRow);
	return result;
};

/** ==[HUMAN APPROVED]== Reads one coherent, bounded selected path and only requested Variant data. */
export const readSelectedHistory = (
	database: Database,
	conversationId: number,
	request: SelectedHistoryReadRequest = {},
): SelectedHistoryRead | undefined => runConversationTransaction(
	database,
	(db) => readSelectedHistoryFromConnection(db, conversationId, request),
);

/** ==[HUMAN APPROVED]== Reuses the same read model when a caller already owns a Conversation connection. */
export { readSelectedHistoryFromConnection };
export type { SelectedHistoryReadRequest };
