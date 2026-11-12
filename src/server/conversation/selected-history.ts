import { MACRO_DATA_NAMESPACE } from "../../shared/variant-data-codecs";
import { isActive } from "../database/is-active";
import { loadMessageRows, toDataEntry } from "./message-rows";
// @approved
//  Focused selected-history read model. Generation and Macro Variable
// consumers need only the selected narrative path; Variant data is read by
// name through readVariantData. Loading every alternative Variant or
// arbitrary metadata makes those reads scale with discarded history.

import type { Database } from "bun:sqlite";
import { and, asc, eq, like, max } from "drizzle-orm";
import {
	conversationDataTable,
	messageTable,
	messageVariantTable,
	participantTable,
} from "../database/schema";
import { findConversation, type ConversationDatabase } from "./internal";
import { toAuthorStamp, toHistoricalContext } from "./message-read-projection";
import { runConversationReadTransaction } from "./commands/transaction";
import type {
	ConversationDataEntry,
	AuthorStampSnapshot,
	HistoricalControlSnapshot,
	SelectedHistoryReadRequest,
} from "./types";
import { ConversationNotFoundError, InvalidConversationCommandError } from "./errors";

export interface SelectedHistoryVariant {
	id: number;
	position: number;
	content: string;
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

const readSelectedHistoryFromConnection = (
	db: ConversationDatabase,
	conversationId: number,
	request: SelectedHistoryReadRequest,
): SelectedHistoryRead | undefined => {
	const conversation = findConversation(db, conversationId);
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
	if (request.conversationDataKeyPrefix !== undefined) {
		initialConditions.push(like(
			conversationDataTable.key,
			`${request.conversationDataKeyPrefix}%`,
		));
	}
	const initialRows = request.conversationData === false ? [] : db
		.select({
			namespace: conversationDataTable.namespace,
			key: conversationDataTable.key,
			value: conversationDataTable.value,
		})
		.from(conversationDataTable)
		.where(and(...initialConditions))
		.all();

	const rows = loadMessageRows(db, conversationId, { ids: request.ids, upToPosition: position, selectedOnly: true });
	const targetRows = targetRow === undefined ? undefined : loadMessageRows(db, conversationId, { ids: [targetRow.id], selectedOnly: true });
	const messageRows = rows.messages;
	const selectedByMessage = new Map<number, SelectedHistoryVariant>();
	for (const loaded of [rows, ...(targetRows === undefined ? [] : [targetRows])]) {
		for (const variant of loaded.variants) selectedByMessage.set(variant.message_id, {
			id: variant.id, position: variant.position, content: variant.content,
		});
	}
	const castIds = new Set(db
		.select({ id: participantTable.id })
		.from(participantTable)
		.where(and(
			eq(participantTable.conversation_id, conversationId),
			isActive(participantTable),
		))
		.all()
		.map((participant) => participant.id));
	type MessageRow = Pick<typeof messageRows[number], "id" | "position" | "author_participant_id" | "author_name" | "context_human_participant_id" | "context_model_participant_id">;
	const toMessage = (message: MessageRow): SelectedHistoryMessage => ({
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
		initialData: initialRows.map(toDataEntry),
		messages: messageRows.map(toMessage),
	};
	if (targetRow !== undefined) result.target = toMessage(targetRow);
	return result;
};

/** @approved Reads one coherent, bounded selected path and only requested Variant data. */
export const readSelectedHistory = (
	database: Database,
	conversationId: number,
	request: SelectedHistoryReadRequest = {},
): SelectedHistoryRead | undefined => runConversationReadTransaction(
	database,
	(db) => readSelectedHistoryFromConnection(db, conversationId, request),
);

/** @approved Reuses the same read model when a caller already owns a Conversation connection. */
export { readSelectedHistoryFromConnection };
export type { SelectedHistoryReadRequest };

/** @approved The selected path's Variant ids in Message order, loading no prose. */
export const readSelectedVariantIdsFromConnection = (db: ConversationDatabase, conversationId: number): number[] => db
	.select({ id: messageVariantTable.id })
	.from(messageTable)
	.innerJoin(messageVariantTable, and(eq(messageVariantTable.message_id, messageTable.id), eq(messageVariantTable.selected, true)))
	.where(eq(messageTable.conversation_id, conversationId))
	.orderBy(asc(messageTable.position))
	.all()
	.map(({ id }) => id);

/** @approved The selected path through the target Message, with that Message shown as the requested Variant. */
export const readHistoryThroughVariant = (db: ConversationDatabase, conversationId: number, variantId: number): SelectedHistoryRead => {
	const target = db.select({ messageId: messageTable.id, messagePosition: messageTable.position, id: messageVariantTable.id, position: messageVariantTable.position, content: messageVariantTable.content }).from(messageTable)
		.innerJoin(messageVariantTable, eq(messageVariantTable.message_id, messageTable.id))
		.where(and(eq(messageTable.conversation_id, conversationId), eq(messageVariantTable.id, variantId))).get();
	if (!target) throw new InvalidConversationCommandError("This reply was deleted; reopen Paint");
	const history = readSelectedHistoryFromConnection(db, conversationId, { position: target.messagePosition, conversationDataNamespace: MACRO_DATA_NAMESPACE });
	if (!history) throw new ConversationNotFoundError(conversationId);
	return { ...history, messages: history.messages.map((message) => message.id === target.messageId
		? { ...message, variant: { id: target.id, position: target.position, content: target.content } } : message) };
};
