import { eq, max } from "drizzle-orm";
import { messageTable } from "../../database/schema";
import { InvalidConversationCommandError } from "../errors";
import type { ConversationDatabase } from "../internal";
import { insertMessage, insertVariants, readControlAssignment, requireParticipant, syncVariantReferences } from "../internal";
import type { ImagePool } from "../../image";
import { syncSelectedMemorySource } from "../../memory";

export interface CreateMessageInput {
	conversationId: number;
	timestamp: string;
	variantContents: readonly string[];
	selectedVariantIndex?: number;
	authorParticipantId: number;
	images?: ImagePool | undefined;
}

export function createMessage(db: ConversationDatabase, input: CreateMessageInput) {
	if (input.variantContents.length === 0) {
		throw new InvalidConversationCommandError(
			"A Message must have at least one Variant.",
		);
	}

	const selectedVariantIndex = input.selectedVariantIndex ?? 0;
	if (
		selectedVariantIndex < 0 ||
		selectedVariantIndex >= input.variantContents.length
	) {
		throw new InvalidConversationCommandError(
			"The selected Variant index is out of range.",
		);
	}

	// ==[HUMAN APPROVED]== The Author Stamp captures the Participant identity plus its current
	// name at Message creation; clients never submit the name.
	const author = requireParticipant(
		db,
		input.conversationId,
		input.authorParticipantId,
	);

	const latestPosition = db
		.select({ value: max(messageTable.position) })
		.from(messageTable)
		.where(eq(messageTable.conversation_id, input.conversationId))
		.get()?.value;
	const messageId = insertMessage(db, {
		conversationId: input.conversationId,
		position: (latestPosition ?? 0) + 1,
		timestamp: input.timestamp,
		author: { participantId: author.id, name: author.name },
		context: null,
	});

	const variantIds = insertVariants(
		db,
		input.variantContents.map((content, index) => ({
			messageId,
			position: index + 1,
			content,
			timestamp: input.timestamp,
			selected: index === selectedVariantIndex,
		})),
	);
	variantIds.forEach((variantId, index) => syncVariantReferences(db, variantId, input.variantContents[index]!, input.images));
	if (author.id === readControlAssignment(db, input.conversationId).humanParticipantId) syncSelectedMemorySource(db.$client, input.conversationId, messageId);
}
