import type { ConversationDatabase } from "../internal";
import { appendSelectedVariant, requireMessage } from "../internal";
import { queueMemorySource } from "../../memory/collections";

export interface CreateVariantInput {
	conversationId: number;
	messageId: number;
	content: string;
}

export function createVariant(db: ConversationDatabase, input: CreateVariantInput) {
	const message = requireMessage(db, input.conversationId, input.messageId);
	appendSelectedVariant(db, {
		messageId: input.messageId,
		content: input.content,
		timestamp: message.timestamp,
	});
	queueMemorySource(db.$client, input.conversationId, input.messageId);
}
