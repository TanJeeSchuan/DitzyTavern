import { eq } from "drizzle-orm";
import { messageVariantTable } from "../../database/schema";
import { syncMemorySources } from "../../memory";
import type { ConversationDatabase } from "../internal";
import { requireVariant, syncVariantReferences } from "../internal";
import type { ImagePool } from "../../image";

export interface EditVariantInput {
	conversationId: number;
	messageId: number;
	variantId: number;
	content: string;
	images?: ImagePool | undefined;
}

export function editVariant(db: ConversationDatabase, input: EditVariantInput) {
	const current = requireVariant(db, input.conversationId, input.messageId, input.variantId);
	if (current.content === input.content) return;
	db.update(messageVariantTable)
		.set({ content: input.content })
		.where(eq(messageVariantTable.id, input.variantId))
		.run();
	syncVariantReferences(db, input.variantId, input.content, input.images);
	syncMemorySources(db.$client, input.conversationId, [input.variantId]);
}
