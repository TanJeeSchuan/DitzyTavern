import { and, asc, eq, gt } from "drizzle-orm";
import { messageVariantTable } from "../../database/schema";
import { queueMemorySource } from "../../memory";
import { cancelMemoryIndexWork } from "../../memory/indexing";
import { InvalidConversationCommandError } from "../errors";
import type { ConversationDatabase } from "../internal";
import { requireVariant } from "../internal";

export interface DeleteVariantInput {
	conversationId: number;
	messageId: number;
	variantId: number;
}

function compactVariantPositions(
	db: ConversationDatabase,
	messageId: number,
	removedPosition: number,
) {
	const laterVariants = db
		.select({ id: messageVariantTable.id, position: messageVariantTable.position })
		.from(messageVariantTable)
		.where(
			and(
				eq(messageVariantTable.message_id, messageId),
				gt(messageVariantTable.position, removedPosition),
			),
		)
		.orderBy(asc(messageVariantTable.position))
		.all();

	for (const variant of laterVariants) {
		db.update(messageVariantTable)
			.set({ position: variant.position - 1 })
			.where(eq(messageVariantTable.id, variant.id))
			.run();
	}
}

export function deleteVariant(db: ConversationDatabase, input: DeleteVariantInput) {
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
	let replacementSelected = false;

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
		replacementSelected = true;
	}

	cancelMemoryIndexWork(db.$client, variant.id);
	db.delete(messageVariantTable)
		.where(eq(messageVariantTable.id, input.variantId))
		.run();
	compactVariantPositions(db, input.messageId, variant.position);
	if (replacementSelected) queueMemorySource(db.$client, input.conversationId, input.messageId);
}
