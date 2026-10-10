import { eq } from "drizzle-orm";
import { messageVariantTable } from "../../database/schema";
import type { ConversationMemoryChange } from "../../../shared/contract/conversation-memory-change";
import type { ConversationDatabase } from "../internal";
import { requireVariant } from "../internal";

export interface EditVariantInput {
	conversationId: number;
	messageId: number;
	variantId: number;
	content: string;
}

export function editVariant(
	db: ConversationDatabase,
	input: EditVariantInput,
): ConversationMemoryChange | void {
	const current = requireVariant(db, input.conversationId, input.messageId, input.variantId);
	if (current.content === input.content) return;
	db.update(messageVariantTable)
		.set({ content: input.content })
		.where(eq(messageVariantTable.id, input.variantId))
		.run();
	return {
		conversationId: input.conversationId,
		touchedVariantIds: [input.variantId],
		removedVariantIds: [],
	};
}
