import { asc, eq, inArray } from "drizzle-orm";
import {
	chatCharacterTable,
	chatDataTable,
	chatTable,
	messageDataTable,
	messageTable,
	messageVariantDataTable,
	messageVariantTable,
} from "../database/schema";
import type { ConversationDatabase } from "./internal";
import type {
	ConversationDataEntry,
	ConversationMessageSnapshot,
	ConversationSnapshot,
	ConversationVariantSnapshot,
} from "./types";

const toDataEntry = (row: { namespace: string; key: string; value: string }) => ({
	namespace: row.namespace,
	key: row.key,
	value: row.value,
});

export function readConversationSnapshot(
	db: ConversationDatabase,
	conversationId: number,
): ConversationSnapshot | undefined {
	const conversation = db
		.select()
		.from(chatTable)
		.where(eq(chatTable.id, conversationId))
		.get();
	if (conversation === undefined) return undefined;

	const messageRows = db
		.select()
		.from(messageTable)
		.where(eq(messageTable.chat_id, conversationId))
		.orderBy(asc(messageTable.position))
		.all();
	const messageIds = messageRows.map((message) => message.id);
	const variantRows =
		messageIds.length === 0
			? []
			: db
					.select()
					.from(messageVariantTable)
					.where(inArray(messageVariantTable.message_id, messageIds))
					.orderBy(
						asc(messageVariantTable.message_id),
						asc(messageVariantTable.position),
					)
					.all();
	const variantIds = variantRows.map((variant) => variant.id);
	const messageDataRows =
		messageIds.length === 0
			? []
			: db
					.select()
					.from(messageDataTable)
					.where(inArray(messageDataTable.message_id, messageIds))
					.orderBy(
						asc(messageDataTable.message_id),
						asc(messageDataTable.namespace),
						asc(messageDataTable.key),
					)
					.all();
	const variantDataRows =
		variantIds.length === 0
			? []
			: db
					.select()
					.from(messageVariantDataTable)
					.where(inArray(messageVariantDataTable.message_variant_id, variantIds))
					.orderBy(
						asc(messageVariantDataTable.message_variant_id),
						asc(messageVariantDataTable.namespace),
						asc(messageVariantDataTable.key),
					)
					.all();

	const variantDataByVariant = new Map<number, ConversationDataEntry[]>();
	for (const row of variantDataRows) {
		const entries = variantDataByVariant.get(row.message_variant_id) ?? [];
		entries.push(toDataEntry(row));
		variantDataByVariant.set(row.message_variant_id, entries);
	}

	const variantsByMessage = new Map<number, ConversationVariantSnapshot[]>();
	for (const variant of variantRows) {
		const variants = variantsByMessage.get(variant.message_id) ?? [];
		variants.push({
			id: variant.id,
			position: variant.position,
			content: variant.content,
			selected: variant.selected,
			data: variantDataByVariant.get(variant.id) ?? [],
		});
		variantsByMessage.set(variant.message_id, variants);
	}

	const messageDataByMessage = new Map<number, ConversationDataEntry[]>();
	for (const row of messageDataRows) {
		const entries = messageDataByMessage.get(row.message_id) ?? [];
		entries.push(toDataEntry(row));
		messageDataByMessage.set(row.message_id, entries);
	}

	const messages: ConversationMessageSnapshot[] = messageRows.map((message) => ({
		id: message.id,
		position: message.position,
		timestamp: message.timestamp,
		variants: variantsByMessage.get(message.id) ?? [],
		data: messageDataByMessage.get(message.id) ?? [],
	}));
	const data = db
		.select()
		.from(chatDataTable)
		.where(eq(chatDataTable.chat_id, conversationId))
		.orderBy(asc(chatDataTable.namespace), asc(chatDataTable.key))
		.all()
		.map(toDataEntry);
	const characterIds = db
		.select({ id: chatCharacterTable.character_id })
		.from(chatCharacterTable)
		.where(eq(chatCharacterTable.chat_id, conversationId))
		.orderBy(asc(chatCharacterTable.character_id))
		.all()
		.map((row) => row.id);

	return {
		id: conversation.id,
		name: conversation.name,
		revision: conversation.revision,
		characterIds,
		messages,
		data,
	};
}
