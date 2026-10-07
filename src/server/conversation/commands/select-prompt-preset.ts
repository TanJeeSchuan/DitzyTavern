import {
	PromptPresetNotFoundError,
	selectConversationPromptPreset,
} from "../../prompt-preset";
import { InvalidConversationCommandError } from "../errors";
import type { ConversationDatabase } from "../internal";
import type { ConversationMemoryChange } from "../../../shared/contract/conversation-memory-change";

// ==[HUMAN APPROVED]== One Conversation's authoritative selection of a shared Prompt
// Preset. The library reference is validated inside the caller's transaction;
// a missing preset is a command error, and the selection write is the only
// Conversation state this command touches — Participant Definitions, Message
// authorship and Generation Settings stay untouched. The transaction's
// connected handle joins the open transaction, so the selection commit is
// atomic with the revision guard.
export const selectPromptPreset = (
	db: ConversationDatabase,
	input: { conversationId: number; promptPresetId: number },
): ConversationMemoryChange | void => {
	try {
		selectConversationPromptPreset(db, input.conversationId, input.promptPresetId);
		// ==[HUMAN APPROVED]== The Memory context of the whole Chat changed with the selected
		// Preset; the change record routes the refresh after the write instead
		// of calling Memory from inside the deep module.
		return {
			conversationId: input.conversationId,
			touchedVariantIds: [],
			removedVariantIds: [],
			promptPresetChanged: true,
		};
	} catch (error) {
		if (error instanceof PromptPresetNotFoundError) {
			throw new InvalidConversationCommandError(
				`Prompt Preset ${input.promptPresetId} does not exist.`,
			);
		}
		throw error;
	}
};
