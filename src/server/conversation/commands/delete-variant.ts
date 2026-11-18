import { and, asc, eq, ne } from "drizzle-orm";
import { messageVariantTable } from "../../database/schema";
import { resequence } from "../../database/resequence";
import type { ConversationWriteChange } from "../../../shared/contract/conversation-write-change";
import { InvalidConversationCommandError } from "../errors";
import type { ConversationDatabase } from "../internal";
import { requireVariant } from "../internal";

export interface DeleteVariantInput {
	conversationId: number;
	messageId: number;
	variantId: number;
}

export function deleteVariant(
	db: ConversationDatabase,
	input: DeleteVariantInput,
): ConversationWriteChange {
	const variant = requireVariant(
		db,
		input.conversationId,
		input.messageId,
		input.variantId,
	);
	const siblings = db
		.select({ id: messageVariantTable.id })
		.from(messageVariantTable)
		.where(and(eq(messageVariantTable.message_id, input.messageId), ne(messageVariantTable.id, variant.id)))
		.orderBy(asc(messageVariantTable.position))
		.all();
	const [firstSibling] = siblings;
	if (firstSibling === undefined) {
		throw new InvalidConversationCommandError(
			"The final Variant of a Message cannot be deleted.",
		);
	}

	const replacementId = variant.selected ? firstSibling.id : undefined;
	if (replacementId !== undefined) {
		db.update(messageVariantTable)
			.set({ selected: false })
			.where(eq(messageVariantTable.id, variant.id))
			.run();
		db.update(messageVariantTable)
			.set({ selected: true })
			.where(eq(messageVariantTable.id, replacementId))
			.run();
	}

	db.delete(messageVariantTable)
		.where(eq(messageVariantTable.id, input.variantId))
		.run();
	resequence(
		db,
		messageVariantTable,
		messageVariantTable.message_id,
		input.messageId,
		siblings.map((sibling) => sibling.id),
	);
	// @approved
	//  Memory re-derives the replacement's collection when selection changes
	// and abandons in-flight work for the deleted Variant.
	return {
		conversationId: input.conversationId,
		touchedVariantIds: replacementId === undefined ? [] : [replacementId],
		removedVariantIds: [input.variantId],
	};
}
