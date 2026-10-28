import { eq } from "drizzle-orm";
import { activeGenerationTable, messageVariantTable } from "../../database/schema";
import { InvalidConversationCommandError } from "../errors";
import type { ConversationWriteChange } from "../../../shared/contract/conversation-write-change";
import type { ConversationDatabase } from "../internal";
import { requireVariant } from "../internal";

export interface EditVariantInput {
	conversationId: number;
	messageId: number;
	variantId: number;
	content: string;
}

export function editVariant(
	db: ConversationDatabase,
	input: EditVariantInput,
): ConversationWriteChange | void {
	const current = requireVariant(db, input.conversationId, input.messageId, input.variantId);
	// @approved
	//  A streaming Variant's text is its Generation's checkpointed output, and
	// the Generation's termination writes over the Variant, so an edit would
	// be hidden at once and lost at the end.
	if (db.select({ id: activeGenerationTable.id }).from(activeGenerationTable).where(eq(activeGenerationTable.variant_id, input.variantId)).get() !== undefined) {
		throw new InvalidConversationCommandError("A Variant cannot be edited while its Generation is running.");
	}
	if (current.content === input.content) return;
	db.update(messageVariantTable)
		.set({ content: input.content })
		.where(eq(messageVariantTable.id, input.variantId))
		.run();
	return {
		conversationId: input.conversationId,
		touchedVariantIds: [input.variantId],
		removedVariantIds: [],
	};
}
