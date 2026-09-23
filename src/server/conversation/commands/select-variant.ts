import { and, eq } from "drizzle-orm";
import { messageVariantTable } from "../../database/schema";
import { invalidateMemoryWorkForVariant } from "../../memory";
import type { ConversationDatabase } from "../internal";
import { requireVariant } from "../internal";

export interface SelectVariantInput {
	conversationId: number;
	messageId: number;
	variantId: number;
}

export function selectVariant(db: ConversationDatabase, input: SelectVariantInput) {
	const selected = requireVariant(db, input.conversationId, input.messageId, input.variantId);
	if (selected.selected) return;
	const previous = db.select({ id: messageVariantTable.id }).from(messageVariantTable)
		.where(and(eq(messageVariantTable.message_id, input.messageId), eq(messageVariantTable.selected, true))).all();
	db.update(messageVariantTable)
		.set({ selected: false })
		.where(eq(messageVariantTable.message_id, input.messageId))
		.run();
	db.update(messageVariantTable)
		.set({ selected: true })
		.where(eq(messageVariantTable.id, input.variantId))
		.run();
	for (const variant of [...previous, { id: input.variantId }]) invalidateMemoryWorkForVariant(db.$client, variant.id);
}
