import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, inArray, isNull, lte } from "drizzle-orm";
import { activeGenerationTable, messageTable, messageVariantTable } from "../database/schema";
import { connectConversationDatabase } from "./internal";
import { readSelectedHistory } from "./selected-history";

export interface MemorySourceVariant {
	messageId: number;
	position: number;
	authorParticipantId: number | null;
	speaker: string | null;
	variantId: number;
	variantPosition: number;
	selected: boolean;
	content: string;
	active: boolean;
}

export function readVariantsForMemory(
	database: Database,
	conversationId: number,
	options: { variantIds?: readonly number[]; includeActive?: boolean } = {},
): MemorySourceVariant[] {
	if (options.variantIds?.length === 0) return [];
	return connectConversationDatabase(database).select({
		messageId: messageTable.id,
		position: messageTable.position,
		authorParticipantId: messageTable.author_participant_id,
		speaker: messageTable.author_name,
		variantId: messageVariantTable.id,
		variantPosition: messageVariantTable.position,
		selected: messageVariantTable.selected,
		content: messageVariantTable.content,
		generationId: activeGenerationTable.id,
	}).from(messageTable)
		.innerJoin(messageVariantTable, eq(messageVariantTable.message_id, messageTable.id))
		.leftJoin(activeGenerationTable, eq(activeGenerationTable.variant_id, messageVariantTable.id))
		.where(and(
			eq(messageTable.conversation_id, conversationId),
			options.variantIds === undefined ? undefined : inArray(messageVariantTable.id, [...options.variantIds]),
			options.includeActive ? undefined : isNull(activeGenerationTable.id),
		))
		.orderBy(asc(messageTable.position), asc(messageVariantTable.position))
		.all().map(({ generationId, ...row }) => ({ ...row, active: generationId !== null }));
}

export function readSelectedPathForMemory(database: Database, conversationId: number, sourceMessageId?: number) {
	const db = connectConversationDatabase(database);
	let ids: number[] | undefined;
	if (sourceMessageId !== undefined) {
		const source = db.select({ position: messageTable.position }).from(messageTable)
			.where(and(eq(messageTable.id, sourceMessageId), eq(messageTable.conversation_id, conversationId))).get();
		if (source === undefined) return [];
		ids = db.select({ id: messageTable.id }).from(messageTable)
			.innerJoin(messageVariantTable, and(eq(messageVariantTable.message_id, messageTable.id), eq(messageVariantTable.selected, true)))
			.where(and(eq(messageTable.conversation_id, conversationId), lte(messageTable.position, source.position)))
			.orderBy(desc(messageTable.position)).limit(5).all().map((row) => row.id);
	}
	const read = readSelectedHistory(database, conversationId, { ids, variantData: false, conversationData: false });
	if (read === undefined) return undefined;
	const active = new Set(connectConversationDatabase(database).select({ id: activeGenerationTable.variant_id }).from(activeGenerationTable)
		.where(eq(activeGenerationTable.conversation_id, conversationId)).all().map((row) => row.id));
	return read.messages.map((message) => ({
		messageId: message.id,
		position: message.position,
		author: message.author?.capturedName ?? null,
		authorParticipantId: message.author?.participantId ?? null,
		variant: message.variant === null ? null : {
			messageId: message.id, position: message.position, authorParticipantId: message.author?.participantId ?? null,
			speaker: message.author?.capturedName ?? null, variantId: message.variant.id, variantPosition: message.variant.position,
			selected: true, content: message.variant.content, active: active.has(message.variant.id),
		},
	}));
}

export const readMessageAuthorsForMemory = (database: Database, conversationId: number) =>
	connectConversationDatabase(database).select({
		messageId: messageTable.id,
		author: messageTable.author_name,
		authorParticipantId: messageTable.author_participant_id,
	}).from(messageTable).where(eq(messageTable.conversation_id, conversationId))
		.orderBy(asc(messageTable.position)).all();

export const readMemoryTailMessageId = (database: Database, conversationId: number): number | undefined =>
	connectConversationDatabase(database).select({ id: messageTable.id }).from(messageTable)
		.where(eq(messageTable.conversation_id, conversationId))
		.orderBy(desc(messageTable.position)).limit(1).get()?.id;
