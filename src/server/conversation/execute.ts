import type { Database } from "bun:sqlite";
import { addParticipant } from "./commands/add-participant";
import { assignControl } from "./commands/assign-control";
import { createMessage } from "./commands/create-message";
import { createVariant } from "./commands/create-variant";
import { deleteData } from "./commands/delete-data";
import { deleteMessage } from "./commands/delete-message";
import { deleteVariant } from "./commands/delete-variant";
import { editVariant } from "./commands/edit-variant";
import {
	updateParticipantDefinition,
	renameParticipant,
	replaceParticipantOpenings,
	replaceParticipantPrompt,
} from "./commands/edit-participant";
import { putData } from "./commands/put-data";
import { removeParticipant } from "./commands/remove-participant";
import { setAuthorNote } from "./commands/set-author-note";
import { renameConversation } from "./commands/rename-conversation";
import {
	attachConversationLorebook,
	attachParticipantLorebook,
	detachConversationLorebook,
	detachParticipantLorebook,
	saveConversationLoreSettings,
} from "./commands/lore-attachments";
import { selectPromptPreset } from "./commands/select-prompt-preset";
import { selectVariant } from "./commands/select-variant";
import { setGenerationModel } from "./commands/set-generation-model";
import { updateConversationGenerationSettings } from "./generation-settings";
import {
	ConversationNotPlayableError,
	InvalidConversationCommandError,
} from "./errors";
import {
	hasActiveGenerationFromConnection,
	isPlayable,
	readControlAssignment,
	requireConversationRevision,
	type ConversationDatabase,
} from "./internal";
import {
	advanceConversationRevisionGuarded,
	requireConversationSummary,
	runConversationTransaction,
} from "./commands/transaction";
import type {
	ConversationAction,
	ConversationCommand,
	ConversationSummary,
} from "./types";
import type { ConversationMemoryChange } from "../../shared/contract/conversation-memory-change";

type ConversationCommandInput<K extends ConversationAction["type"]> = {
	conversationId: number;
} & Extract<ConversationAction, { type: K }>;

type CommandHandler<K extends ConversationAction["type"]> = (
	db: ConversationDatabase,
	input: ConversationCommandInput<K>,
) => ConversationMemoryChange | void;

const handlers = {
	"create-message": createMessage,
	"create-variant": createVariant,
	"select-variant": selectVariant,
	"edit-variant": editVariant,
	"delete-variant": deleteVariant,
	"delete-message": deleteMessage,
	"add-participant": addParticipant,
	"rename-participant": renameParticipant,
	"update-participant-definition": updateParticipantDefinition,
	"replace-participant-prompt": replaceParticipantPrompt,
	"replace-participant-openings": replaceParticipantOpenings,
	"assign-control": assignControl,
	"remove-participant": removeParticipant,
	"put-data": putData,
	"delete-data": deleteData,
	"update-generation-settings": (db, input) => { updateConversationGenerationSettings(db, input.conversationId, input.settings); },
	"set-generation-model": (db, input) => { setGenerationModel(db, input); },
	"select-prompt-preset": selectPromptPreset,
	"set-author-note": setAuthorNote,
	"rename-conversation": renameConversation,
	"attach-chat": attachConversationLorebook,
	"detach-chat": detachConversationLorebook,
	"attach-participant": attachParticipantLorebook,
	"detach-participant": detachParticipantLorebook,
	"save-settings": saveConversationLoreSettings,
} satisfies { [K in ConversationAction["type"]]: CommandHandler<K> };

const playOnly = new Set<ConversationAction["type"]>(["create-message", "create-variant"]);
const quietOnly = new Set<ConversationAction["type"]>([...playOnly, "assign-control"]);

export function executeConversationCommand(
	database: Database,
	command: ConversationCommand,
): ConversationSummary {
	return runConversationTransaction(database, (db, reportChange) => {
		const conversation = requireConversationRevision(
			db,
			command.conversationId,
			command.expectedRevision,
			"conversation",
		);
		if (
			quietOnly.has(command.action.type) &&
			hasActiveGenerationFromConnection(db, command.conversationId)
		) {
			throw new InvalidConversationCommandError(
				"A new Conversation turn, Variant creation, or Control mutation is unavailable while an Active Generation exists.",
			);
		}
		if (
			playOnly.has(command.action.type) &&
			!isPlayable(readControlAssignment(db, command.conversationId))
		) {
			throw new ConversationNotPlayableError(command.conversationId);
		}

		const input = { conversationId: command.conversationId, ...command.action };
		// @approved
		// SAFETY: satisfies checks each handler against its action; indexing loses that correlation.
		const reportedChange = (handlers[input.type] as CommandHandler<typeof input.type>)(db, input);

		advanceConversationRevisionGuarded(
			db,
			command.conversationId,
			command.expectedRevision,
			conversation.revision,
		);
		if (reportedChange !== undefined) reportChange(reportedChange);
		return requireConversationSummary(db, command.conversationId);
	});
}
