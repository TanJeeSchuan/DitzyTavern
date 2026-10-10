import { asc, eq } from "drizzle-orm";
import { messageVariantTable } from "../../database/schema";
import { resequence } from "../../database/resequence";
import type { ConversationMemoryChange } from "../../../shared/contract/conversation-memory-change";
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
): ConversationMemoryChange | void {
	const variant = requireVariant(
		db,
		input.conversationId,
		input.messageId,
		input.variantId,
	);
	const siblings = db
		.select()
		.from(messageVariantTable)
		.where(eq(messageVariantTable.message_id, input.messageId))
		.orderBy(asc(messageVariantTable.position))
		.all();
	let replacementId: number | undefined;

	if (siblings.length === 1) {
		throw new InvalidConversationCommandError(
			"The final Variant of a Message cannot be deleted.",
		);
	}

	if (variant.selected) {
		const replacement = siblings.find((sibling) => sibling.id !== input.variantId);
		if (replacement === undefined) {
			throw new InvalidConversationCommandError(
				"A replacement Variant is required.",
			);
		}
		db.update(messageVariantTable)
			.set({ selected: false })
			.where(eq(messageVariantTable.id, variant.id))
			.run();
		db.update(messageVariantTable)
			.set({ selected: true })
			.where(eq(messageVariantTable.id, replacement.id))
			.run();
		replacementId = replacement.id;
	}

	db.delete(messageVariantTable)
		.where(eq(messageVariantTable.id, input.variantId))
		.run();
	resequence(
		db,
		messageVariantTable,
		messageVariantTable.message_id,
		input.messageId,
		siblings
			.filter((sibling) => sibling.id !== input.variantId)
			.map((sibling) => sibling.id),
	);
	// @approved
	//  The replacing Swipe re-derives its Memory collection; the
	// removed Variant's in-flight work is abandoned in both cases so a deleted
	// source never keeps a provider call or a Memory worker slot alive.
	if (replacementId === undefined) {
		return {
			conversationId: input.conversationId,
			touchedVariantIds: [],
			removedVariantIds: [input.variantId],
		};
	}
	return {
		conversationId: input.conversationId,
		touchedVariantIds: [replacementId],
		removedVariantIds: [input.variantId],
	};
}
