import type { ConversationMemoryChange } from "../../../shared/contract/conversation-memory-change";
import type { ConversationDatabase } from "../internal";
import { appendSelectedVariant, requireMessage } from "../internal";

export interface CreateVariantInput {
	conversationId: number;
	messageId: number;
	content: string;
}

export function createVariant(
	db: ConversationDatabase,
	input: CreateVariantInput,
): ConversationMemoryChange {
	const message = requireMessage(db, input.conversationId, input.messageId);
	const variantId = appendSelectedVariant(db, {
		messageId: input.messageId,
		content: input.content,
		timestamp: message.timestamp,
	});
	return {
		conversationId: input.conversationId,
		touchedVariantIds: [variantId],
		removedVariantIds: [],
		promptPresetChanged: false,
	};
}
