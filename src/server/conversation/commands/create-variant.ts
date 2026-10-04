import type { ConversationDatabase } from "../internal";
import { appendSelectedVariant, requireMessage, syncVariantReferences } from "../internal";
import type { ImagePool } from "../../image";
import { syncMemorySources } from "../../memory";

export interface CreateVariantInput {
	conversationId: number;
	messageId: number;
	content: string;
	images?: ImagePool | undefined;
}

export function createVariant(db: ConversationDatabase, input: CreateVariantInput) {
	const message = requireMessage(db, input.conversationId, input.messageId);
	const variantId = appendSelectedVariant(db, {
		messageId: input.messageId,
		content: input.content,
		timestamp: message.timestamp,
	});
	syncVariantReferences(db, variantId, input.content, input.images);
	syncMemorySources(db.$client, input.conversationId, [variantId]);
}
