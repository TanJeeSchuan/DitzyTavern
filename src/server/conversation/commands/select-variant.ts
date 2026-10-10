import { eq } from "drizzle-orm";
import { messageVariantTable } from "../../database/schema";
import type { ConversationMemoryChange } from "../../../shared/contract/conversation-memory-change";
import type { ConversationDatabase } from "../internal";
import { requireVariant } from "../internal";

export interface SelectVariantInput {
	conversationId: number;
	messageId: number;
	variantId: number;
}

export function selectVariant(
	db: ConversationDatabase,
	input: SelectVariantInput,
): ConversationMemoryChange | void {
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
	return {
		conversationId: input.conversationId,
		touchedVariantIds: [input.variantId],
		removedVariantIds: [],
	};
}
