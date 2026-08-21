import { eq, max } from "drizzle-orm";
import { messageVariantTable } from "../../database/schema";
import type { ConversationDatabase } from "../internal";
import { requireMessage } from "../internal";

export interface CreateVariantInput {
	conversationId: number;
	messageId: number;
	content: string;
}

export function createVariant(db: ConversationDatabase, input: CreateVariantInput) {
	requireMessage(db, input.conversationId, input.messageId);
	const latestPosition = db
		.select({ value: max(messageVariantTable.position) })
		.from(messageVariantTable)
		.where(eq(messageVariantTable.message_id, input.messageId))
		.get()?.value;

	db.update(messageVariantTable)
		.set({ selected: false })
		.where(eq(messageVariantTable.message_id, input.messageId))
		.run();
	db.insert(messageVariantTable)
		.values({
			message_id: input.messageId,
			position: (latestPosition ?? 0) + 1,
			content: input.content,
			selected: true,
		})
		.run();
}
