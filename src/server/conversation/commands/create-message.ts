import { eq, max } from "drizzle-orm";
import { messageTable } from "../../database/schema";
import type { ConversationMemoryChange } from "../../../shared/contract/conversation-memory-change";
import { InvalidConversationCommandError } from "../errors";
import type { ConversationDatabase } from "../internal";
import { insertMessage, insertVariants, readControlAssignment, requireParticipant } from "../internal";

export interface CreateMessageInput {
	conversationId: number;
	timestamp: string;
	variantContents: readonly string[];
	selectedVariantIndex?: number;
	authorParticipantId: number;
}

export function createMessage(
	db: ConversationDatabase,
	input: CreateMessageInput,
): ConversationMemoryChange | void {
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

	// @approved
	//  The Author Stamp captures the Participant identity plus its current
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
	// @approved
	//  Only a Human-authored Message is reported: Memory derives a
	// source from the Human's selected Variant, while model turns are
	// remembered through their own Generation resolution.
	if (author.id === readControlAssignment(db, input.conversationId).humanParticipantId) {
		return {
			conversationId: input.conversationId,
			touchedVariantIds: variantIds,
			removedVariantIds: [],
		};
	}
}
