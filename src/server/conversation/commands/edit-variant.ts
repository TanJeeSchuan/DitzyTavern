import { eq } from "drizzle-orm";
import { messageVariantTable } from "../../database/schema";
import { invalidateMemoryWorkForVariant, queueMemorySource } from "../../memory";
import type { ConversationDatabase } from "../internal";
import { requireVariant } from "../internal";

export interface EditVariantInput {
	conversationId: number;
	messageId: number;
	variantId: number;
	content: string;
}

export function editVariant(db: ConversationDatabase, input: EditVariantInput) {
	const current = requireVariant(db, input.conversationId, input.messageId, input.variantId);
	if (current.content === input.content) return;
	db.update(messageVariantTable)
		.set({ content: input.content })
		.where(eq(messageVariantTable.id, input.variantId))
		.run();
	invalidateMemoryWorkForVariant(db.$client, input.variantId);
	if (current.selected && input.content.trim()) queueMemorySource(db.$client, input.conversationId, input.messageId);
}
