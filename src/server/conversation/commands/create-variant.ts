import { eq } from "drizzle-orm";
import { messageVariantDataTable } from "../../database/schema";
import type { ConversationWriteChange } from "../../../shared/contract/conversation-write-change";
import { BOX_TRACES_NAMESPACE, GENERATION_DATA_KEYS, GENERATION_DATA_NAMESPACE, LORE_ACTIVATION_NAMESPACE } from "../../../shared/variant-data-codecs";
import type { ConversationDatabase } from "../internal";
import { appendSelectedVariant, requireMessage, requireVariant } from "../internal";

export interface CreateVariantInput {
	conversationId: number;
	messageId: number;
	sourceVariantId: number;
	content: string;
}

// @approved
//  The copy is written, not generated: it keeps the source's state (Box
// records and seed, macro writes, Reasoning) so selecting it folds the same,
// and drops the evidence of the Generation that wrote the source.
const isGenerationEvidence = ({ namespace, key }: { namespace: string; key: string }) =>
	namespace === LORE_ACTIVATION_NAMESPACE || namespace === BOX_TRACES_NAMESPACE
	|| (namespace === GENERATION_DATA_NAMESPACE && key !== GENERATION_DATA_KEYS.reasoning);

export function createVariant(
	db: ConversationDatabase,
	input: CreateVariantInput,
): ConversationWriteChange {
	const message = requireMessage(db, input.conversationId, input.messageId);
	requireVariant(db, input.conversationId, input.messageId, input.sourceVariantId);
	const variantId = appendSelectedVariant(db, {
		messageId: input.messageId,
		content: input.content,
		timestamp: message.timestamp,
	});
	const { namespace, key, value } = messageVariantDataTable;
	const rows = db.select({ namespace, key, value }).from(messageVariantDataTable)
		.where(eq(messageVariantDataTable.message_variant_id, input.sourceVariantId)).all()
		.filter((row) => !isGenerationEvidence(row));
	if (rows.length > 0) db.insert(messageVariantDataTable).values(rows.map((row) => ({ ...row, message_variant_id: variantId }))).run();
	return {
		conversationId: input.conversationId,
		touchedVariantIds: [variantId],
		removedVariantIds: [],
	};
}
