import { eq, max } from "drizzle-orm";
import { messageTable, messageVariantTable } from "../../database/schema";
import { InvalidConversationCommandError } from "../errors";
import type { ConversationDatabase } from "../internal";
import { requireParticipant } from "../internal";

export interface CreateMessageInput {
	conversationId: number;
	timestamp: string;
	variantContents: readonly string[];
	selectedVariantIndex?: number;
	authorParticipantId: number;
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
		.where(eq(messageTable.chat_id, input.conversationId))
		.get()?.value;
	const message = db
		.insert(messageTable)
		.values({
			chat_id: input.conversationId,
			position: (latestPosition ?? 0) + 1,
			timestamp: input.timestamp,
			author_participant_id: author.id,
			author_name: author.name,
		})
		.returning()
		.get();

	db.insert(messageVariantTable)
		.values(
			input.variantContents.map((content, index) => ({
				message_id: message.id,
				position: index + 1,
				content,
				timestamp: input.timestamp,
				selected: index === selectedVariantIndex,
			})),
		)
		.run();
}
