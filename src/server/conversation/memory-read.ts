import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
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

export function readSelectedPathForMemory(database: Database, conversationId: number) {
	const read = readSelectedHistory(database, conversationId);
	if (read === undefined) return undefined;
	const variants = new Map(readVariantsForMemory(database, conversationId, { includeActive: true }).map((variant) => [variant.variantId, variant]));
	return read.messages.map((message) => ({
		messageId: message.id,
		position: message.position,
		author: message.author?.capturedName ?? null,
		authorParticipantId: message.author?.participantId ?? null,
		variant: message.variant === null ? null : variants.get(message.variant.id) ?? null,
	}));
}
