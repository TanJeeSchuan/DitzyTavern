import { and, eq } from "drizzle-orm";
import {
	conversationLoreSettingsTable,
	conversationLorebookAttachmentTable,
	participantLorebookAttachmentTable,
} from "../../database/schema";
import {
	InvalidConversationCommandError,
	ParticipantNotFoundError,
} from "../errors";
import { type ConversationDatabase, findActiveParticipant } from "../internal";

// @approved
//  The Conversation-owned Lore attachment commands: Chat Lore settings
// and Chat/Participant Lorebook attachments are revisioned Conversation
// mutations executed through the shared command seam. They touch no Variant,
// so they report no write change.

// @approved
//  Re-checks the Participant inside the command transaction. The
// Lorebook attachment wire command carries no conversation id, so the
// transport derives it from the Participant's Chat reference before
// dispatch; this lookup keeps the old atomicity, where the owner read and
// the write shared one immediate transaction.
const requireConversationLoreParticipant = (
	db: ConversationDatabase,
	conversationId: number,
	participantId: number,
): void => {
	if (findActiveParticipant(db, conversationId, participantId) === undefined) {
		throw new ParticipantNotFoundError(conversationId, participantId);
	}
};

export const attachConversationLorebook = (
	db: ConversationDatabase,
	input: { conversationId: number; bookId: number; enabled?: boolean | undefined },
): void => {
	db.insert(conversationLorebookAttachmentTable)
		.values({
			conversation_id: input.conversationId,
			lorebook_id: input.bookId,
			enabled: input.enabled ?? true,
		})
		.onConflictDoUpdate({
			target: [conversationLorebookAttachmentTable.conversation_id, conversationLorebookAttachmentTable.lorebook_id],
			set: { enabled: input.enabled ?? true },
		})
		.run();
};

export const detachConversationLorebook = (
	db: ConversationDatabase,
	input: { conversationId: number; bookId: number },
): void => {
	db.delete(conversationLorebookAttachmentTable)
		.where(
			and(
				eq(conversationLorebookAttachmentTable.conversation_id, input.conversationId),
				eq(conversationLorebookAttachmentTable.lorebook_id, input.bookId),
			),
		)
		.run();
};

export const attachParticipantLorebook = (
	db: ConversationDatabase,
	input: { conversationId: number; participantId: number; bookId: number; scope: "controlled-participant" | "cast"; enabled?: boolean | undefined },
): void => {
	requireConversationLoreParticipant(db, input.conversationId, input.participantId);
	db.insert(participantLorebookAttachmentTable)
		.values({
			participant_id: input.participantId,
			lorebook_id: input.bookId,
			scope: input.scope,
			enabled: input.enabled ?? true,
		})
		.onConflictDoUpdate({
			target: [participantLorebookAttachmentTable.participant_id, participantLorebookAttachmentTable.lorebook_id, participantLorebookAttachmentTable.scope],
			set: { enabled: input.enabled ?? true },
		})
		.run();
};

export const detachParticipantLorebook = (
	db: ConversationDatabase,
	input: { conversationId: number; participantId: number; bookId: number; scope: "controlled-participant" | "cast" },
): void => {
	requireConversationLoreParticipant(db, input.conversationId, input.participantId);
	db.delete(participantLorebookAttachmentTable)
		.where(
			and(
				eq(participantLorebookAttachmentTable.participant_id, input.participantId),
				eq(participantLorebookAttachmentTable.lorebook_id, input.bookId),
				eq(participantLorebookAttachmentTable.scope, input.scope),
			),
		)
		.run();
};

export const saveConversationLoreSettings = (
	db: ConversationDatabase,
	input: { conversationId: number; scanDepth: number; allowance: number },
): void => {
	if (!Number.isInteger(input.scanDepth) || input.scanDepth < 0) {
		throw new InvalidConversationCommandError("Lore scan depth must be a non-negative whole number.");
	}
	if (!Number.isInteger(input.allowance) || input.allowance < 0) {
		throw new InvalidConversationCommandError("Lore allowance must be a non-negative whole number.");
	}
	db.insert(conversationLoreSettingsTable)
		.values({
			conversation_id: input.conversationId,
			scan_depth: input.scanDepth,
			allowance: input.allowance,
		})
		.onConflictDoUpdate({
			target: conversationLoreSettingsTable.conversation_id,
			set: { scan_depth: input.scanDepth, allowance: input.allowance },
		})
		.run();
};
