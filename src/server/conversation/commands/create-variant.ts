import type { ConversationDatabase } from "../internal";
import { appendSelectedVariant, requireMessage } from "../internal";
import { syncMemorySources } from "../../memory";

export interface CreateVariantInput {
	conversationId: number;
	messageId: number;
	content: string;
}

export function createVariant(db: ConversationDatabase, input: CreateVariantInput) {
	const message = requireMessage(db, input.conversationId, input.messageId);
	const variantId = appendSelectedVariant(db, {
		messageId: input.messageId,
		content: input.content,
		timestamp: message.timestamp,
	});

	syncMemorySources(db.$client, input.conversationId, [variantId]);
}
