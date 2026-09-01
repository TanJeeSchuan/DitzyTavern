import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { activeGenerationTable, chatTable } from "../database/schema";
import { addParticipant } from "./commands/add-participant";
import { assignControl } from "./commands/assign-control";
import { createMessage } from "./commands/create-message";
import { createVariant } from "./commands/create-variant";
import { deleteData } from "./commands/delete-data";
import { deleteMessage } from "./commands/delete-message";
import { deleteVariant } from "./commands/delete-variant";
import { editVariant } from "./commands/edit-variant";
import {
	renameParticipant,
	replaceParticipantOpenings,
	replaceParticipantPrompt,
} from "./commands/edit-participant";
import { putData } from "./commands/put-data";
import { removeParticipant } from "./commands/remove-participant";
import { selectVariant } from "./commands/select-variant";
import { setGenerationModel } from "./commands/set-generation-model";
import { updateConversationGenerationSettings } from "./generation-settings";
import {
	ConversationNotPlayableError,
	ConversationNotFoundError,
	InvalidConversationCommandError,
	StaleConversationRevisionError,
} from "./errors";
import {
	isPlayable,
	readControlAssignment,
} from "./internal";
import {
	advanceConversationRevisionGuarded,
	requireConversationSnapshot,
	runConversationTransaction,
} from "./commands/transaction";
import type { ConversationCommand, ConversationSnapshot } from "./types";

export function executeConversationCommand(
	database: Database,
	command: ConversationCommand,
): ConversationSnapshot {
	return runConversationTransaction(database, (db) => {
		const conversation = db
			.select({ revision: chatTable.revision })
			.from(chatTable)
			.where(eq(chatTable.id, command.conversationId))
			.get();
		if (conversation === undefined) {
			throw new ConversationNotFoundError(command.conversationId);
		}
		if (conversation.revision !== command.expectedRevision) {
			throw new StaleConversationRevisionError(
				command.expectedRevision,
				conversation.revision,
			);
		}
		const responsePositionIsActive = db
			.select({ id: activeGenerationTable.id })
			.from(activeGenerationTable)
			.where(eq(activeGenerationTable.chat_id, command.conversationId))
			.get() !== undefined;
		if (
			responsePositionIsActive &&
			(command.action.type === "create-message" ||
				command.action.type === "create-variant" ||
				command.action.type === "assign-control")
		) {
			throw new InvalidConversationCommandError(
				"A new Conversation turn, Variant creation, or Control mutation is unavailable while an Active Generation exists.",
			);
		}

		// Compose and Swipe/Generate are play actions: they require both
		// distinct Control seats. Reads, edits, configuration, and deletion
		// remain available to incomplete Conversations.
		if (
			command.action.type === "create-message" ||
			command.action.type === "create-variant"
		) {
			if (!isPlayable(readControlAssignment(db, command.conversationId))) {
				throw new ConversationNotPlayableError(command.conversationId);
			}
		}

		const input = { conversationId: command.conversationId, ...command.action };
		switch (input.type) {
			case "create-message":
				createMessage(db, input);
				break;
			case "create-variant":
				createVariant(db, input);
				break;
			case "select-variant":
				selectVariant(db, input);
				break;
			case "edit-variant":
				editVariant(db, input);
				break;
			case "delete-variant":
				deleteVariant(db, input);
				break;
			case "delete-message":
				deleteMessage(db, input);
				break;
			case "add-participant":
				addParticipant(db, input);
				break;
			case "rename-participant":
				renameParticipant(db, input);
				break;
			case "replace-participant-prompt":
				replaceParticipantPrompt(db, input);
				break;
			case "replace-participant-openings":
				replaceParticipantOpenings(db, input);
				break;
			case "assign-control":
				assignControl(db, input);
				break;
			case "remove-participant":
				removeParticipant(db, input);
				break;
			case "put-data":
				putData(db, input);
				break;
			case "delete-data":
				deleteData(db, input);
				break;
			case "update-generation-settings":
				updateConversationGenerationSettings(db, input.conversationId, input.settings);
				break;
			case "set-generation-model":
				setGenerationModel(db, input);
				break;
		}

		advanceConversationRevisionGuarded(
			db,
			command.conversationId,
			command.expectedRevision,
			conversation.revision,
		);
		return requireConversationSnapshot(db, command.conversationId);
	});
}
