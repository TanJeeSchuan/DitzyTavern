import type { Database } from "bun:sqlite";
import { eq, max } from "drizzle-orm";
import {
	chatTable,
	messageTable,
	messageVariantTable,
} from "../../database/schema";
import {
	ConversationNotFoundError,
	InvalidConversationCommandError,
} from "../errors";
import { requireParticipant } from "../internal";
import {
	advanceConversationRevision,
	runConversationTransaction,
} from "./transaction";
import { persistTerminalVariantData } from "./active-generation";
import type { CommitGenerationInput, ConversationSnapshot } from "../types";

// Commits a finished current Generate. The generation workflow captured the
// Author Stamp (author Participant plus name) and the human/model Control
// pair at generation start; this operation persists an immutable historical
// pair and stamp exactly as captured, so concurrent renames or Definition
// edits cannot rewrite an in-flight generation.
//
// Unlike client-submitted commands this server-side commit is not guarded by
// an expected revision: legitimate concurrent edits are allowed to land
// while the transport streams, and affect only later generations.
export function commitConversationGeneration(
	database: Database,
	input: CommitGenerationInput,
): ConversationSnapshot {
	return runConversationTransaction(database, (db) => {
		const conversation = db
			.select({ id: chatTable.id })
			.from(chatTable)
			.where(eq(chatTable.id, input.conversationId))
			.get();
		if (conversation === undefined) {
			throw new ConversationNotFoundError(input.conversationId);
		}

		if (input.authorParticipantId !== input.modelParticipantId) {
			throw new InvalidConversationCommandError(
				"A generated Message must be authored by the model Participant of the captured generation pair.",
			);
		}
		if (input.humanParticipantId === input.modelParticipantId) {
			throw new InvalidConversationCommandError(
				"The captured human and model seats of a generation must be distinct Participants.",
			);
		}
		// Both seats must still belong to this Conversation; the stamp keeps
		// the generation-start name even when a seat was renamed in flight.
		requireParticipant(db, input.conversationId, input.humanParticipantId);
		requireParticipant(db, input.conversationId, input.modelParticipantId);

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
				author_participant_id: input.authorParticipantId,
				author_name: input.capturedAuthorName,
				context_human_participant_id: input.humanParticipantId,
				context_model_participant_id: input.modelParticipantId,
			})
			.returning()
			.get();

		const variant = db.insert(messageVariantTable)
			.values({
				message_id: message.id,
				position: 1,
				content: input.content,
				timestamp: input.timestamp,
				selected: true,
			})
			.returning({ id: messageVariantTable.id })
			.get();
		if (variant === undefined) {
			throw new InvalidConversationCommandError(
				"The generated Variant could not be persisted.",
			);
		}
		persistTerminalVariantData(db, variant.id, {
			provenance: input.provenance,
			suppliedData: input.data ?? [],
		});

		return advanceConversationRevision(db, input.conversationId);
	});
}
