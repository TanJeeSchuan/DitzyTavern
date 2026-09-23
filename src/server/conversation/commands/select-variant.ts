import { eq } from "drizzle-orm";
import { messageVariantTable } from "../../database/schema";
import { queueMemorySource } from "../../memory/collections";
import type { ConversationDatabase } from "../internal";
import { requireVariant } from "../internal";

export interface SelectVariantInput {
	conversationId: number;
	messageId: number;
	variantId: number;
}

export function selectVariant(db: ConversationDatabase, input: SelectVariantInput) {
	const selected = requireVariant(db, input.conversationId, input.messageId, input.variantId);
	if (selected.selected) return;
	db.update(messageVariantTable)
		.set({ selected: false })
		.where(eq(messageVariantTable.message_id, input.messageId))
		.run();
	db.update(messageVariantTable)
		.set({ selected: true })
		.where(eq(messageVariantTable.id, input.variantId))
		.run();
	queueMemorySource(db.$client, input.conversationId, input.messageId);
}
