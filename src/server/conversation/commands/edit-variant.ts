import { eq } from "drizzle-orm";
import { messageVariantTable } from "../../database/schema";
import type { ConversationDatabase } from "../internal";
import { requireVariant } from "../internal";

export interface EditVariantInput {
	conversationId: number;
	messageId: number;
	variantId: number;
	content: string;
}

export function editVariant(db: ConversationDatabase, input: EditVariantInput) {
	requireVariant(db, input.conversationId, input.messageId, input.variantId);
	db.update(messageVariantTable)
		.set({ content: input.content })
		.where(eq(messageVariantTable.id, input.variantId))
		.run();
}
