import type { Database } from "bun:sqlite";
import { eq, max, sql } from "drizzle-orm";
import {
	chatTable,
	messageVariantTable,
	participantPromptTable,
	participantTable,
} from "../../database/schema";
import {
	ConversationNotFoundError,
	SiblingVariantUnavailableError,
} from "../errors";
import {
	connectConversationDatabase,
	requireMessage,
} from "../internal";
import { readConversationSnapshot } from "../snapshot";
import type { CommitSiblingVariantInput, ConversationSnapshot } from "../types";

// Commits a finished targeted Swipe (sibling Variant generation). The
// workflow captured the Prompt Plan from the target Message's historical
// Control pair at generation start; this operation appends the returned
// content as a new selected sibling Variant on that Message without touching
// current Control, the Message timestamp, or its immutable Author Stamp.
//
// Like commitGeneration this server-side commit is not guarded by an
// expected revision: legitimate concurrent edits are allowed to land while
// the transport streams, and affect only later generations. The target
// Message's historical context is immutable, but the commit re-verifies that
// both historical Participants still have usable Definitions so a removal
// that lands mid-flight cannot commit a sibling under a ghost pair.
export function commitConversationSiblingVariant(
	database: Database,
	input: CommitSiblingVariantInput,
): ConversationSnapshot {
	const commit = database.transaction(() => {
		const db = connectConversationDatabase(database);

		const conversation = db
			.select({ id: chatTable.id })
			.from(chatTable)
			.where(eq(chatTable.id, input.conversationId))
			.get();
		if (conversation === undefined) {
			throw new ConversationNotFoundError(input.conversationId);
		}

		const message = requireMessage(
			db,
			input.conversationId,
			input.messageId,
		);
		if (
			message.context_human_participant_id === null ||
			message.context_model_participant_id === null
		) {
			throw new SiblingVariantUnavailableError("missing-historical-context");
		}

		// The historical pair must still be usable Cast members, matching the
		// snapshot's Cast derivation exactly: a Participant with a stripped
		// Definition (tombstoned) is excluded even though its base row may
		// still satisfy structural foreign keys.
		const castIds = db
			.select({ id: participantTable.id })
			.from(participantTable)
			.innerJoin(
				participantPromptTable,
				eq(participantPromptTable.participant_id, participantTable.id),
			)
			.where(eq(participantTable.chat_id, input.conversationId))
			.all()
			.map((participant) => participant.id);
		if (
			!castIds.includes(message.context_human_participant_id) ||
			!castIds.includes(message.context_model_participant_id)
		) {
			throw new SiblingVariantUnavailableError(
				"historical-participant-unavailable",
			);
		}

		const latestPosition = db
			.select({ value: max(messageVariantTable.position) })
			.from(messageVariantTable)
			.where(eq(messageVariantTable.message_id, input.messageId))
			.get()?.value;

		db.update(messageVariantTable)
			.set({ selected: false })
			.where(eq(messageVariantTable.message_id, input.messageId))
			.run();
		db.insert(messageVariantTable)
			.values({
				message_id: input.messageId,
				position: (latestPosition ?? 0) + 1,
				content: input.content,
				timestamp: input.timestamp,
				selected: true,
			})
			.run();

		db.update(chatTable)
			.set({ revision: sql`${chatTable.revision} + 1` })
			.where(eq(chatTable.id, input.conversationId))
			.run();

		const snapshot = readConversationSnapshot(db, input.conversationId);
		if (snapshot === undefined) {
			throw new ConversationNotFoundError(input.conversationId);
		}
		return snapshot;
	});

	return commit.immediate();
}