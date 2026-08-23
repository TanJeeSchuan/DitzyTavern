import type { Database } from "bun:sqlite";
import { and, eq, isNull, max, sql } from "drizzle-orm";
import {
	chatTable,
	messageVariantTable,
	participantPromptTable,
	participantTable,
} from "../../database/schema";
import {
	ConversationNotFoundError,
	ConversationNotPlayableError,
	SiblingVariantUnavailableError,
} from "../errors";
import {
	connectConversationDatabase,
	isPlayable,
	readControlAssignment,
	requireMessage,
} from "../internal";
import { deriveMessageSwipeEligibility, readConversationSnapshot } from "../snapshot";
import type {
	CommitSiblingVariantInput,
	ConversationSnapshot,
	HistoricalControlSnapshot,
} from "../types";

// Commits a finished targeted Swipe (sibling Variant generation). The
// workflow captured the Prompt Plan from the target Message's historical
// Control pair at generation start; this operation appends the returned
// content as a new selected sibling Variant on that Message without touching
// current Control, the Message timestamp, or its immutable Author Stamp.
//
// Like commitGeneration this server-side commit is not guarded by an
// expected revision: legitimate concurrent edits are allowed to land while
// the transport streams, and affect only later generations. The commit
// re-derives the target's swipe eligibility from live state anyway: a
// removal or Control change that lands mid-flight must not commit a sibling
// under a ghost pair or in a Conversation that is no longer playable.
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
		const historicalContext: HistoricalControlSnapshot | null =
			message.context_human_participant_id !== null &&
			message.context_model_participant_id !== null
				? {
						humanParticipantId: message.context_human_participant_id,
						modelParticipantId: message.context_model_participant_id,
					}
				: null;

		// Usable Cast membership matches the snapshot's Cast derivation
		// exactly: a Participant with a stripped Definition (tombstoned) is
		// excluded even though its base row may still satisfy structural
		// foreign keys.
		const castIds = db
			.select({ id: participantTable.id })
			.from(participantTable)
			.innerJoin(
				participantPromptTable,
				eq(participantPromptTable.participant_id, participantTable.id),
			)
			.where(
				and(
					eq(participantTable.chat_id, input.conversationId),
					isNull(participantTable.deleted_at),
				),
			)
			.all()
			.map((participant) => participant.id);

		// The same derived rule the snapshot exposes, re-verified inside the
		// commit: playable seats, captured historical pair, and both
		// historical Participants still usable.
		const eligibility = deriveMessageSwipeEligibility(
			isPlayable(readControlAssignment(db, input.conversationId)),
			historicalContext,
			castIds,
		);
		if (!eligibility.eligible) {
			if (eligibility.reason === "conversation-not-playable") {
				throw new ConversationNotPlayableError(input.conversationId);
			}
			throw new SiblingVariantUnavailableError(eligibility.reason);
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