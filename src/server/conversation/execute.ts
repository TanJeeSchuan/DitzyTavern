import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { chatTable } from "../database/schema";
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
	hasActiveGeneration,
	isPlayable,
	readControlAssignment,
	type ConversationDatabase,
} from "./internal";
import {
	advanceConversationRevisionGuarded,
	requireConversationSnapshot,
	runConversationTransaction,
} from "./commands/transaction";
import type { ConversationAction, ConversationCommand, ConversationSnapshot } from "./types";

// ==[HUMAN APPROVED]== The per-command gate policy: each command declares whether it
// requires a playable Conversation and whether an Active Generation blocks
// it. Compose (create-message) and Swipe creation (create-variant) are play
// actions needing both distinct Control seats; Control mutation joins them
// behind the Active-Generation gate. Reads, edits, configuration, and
// deletion remain available to incomplete Conversations. The table is the
// one place a command's gates are stated, so a new command cannot silently
// skip the shared gates.
export interface ConversationCommandPolicy<K extends ConversationAction["type"]> {
	handler: (db: ConversationDatabase, input: ConversationCommandInput<K>) => void;
	requiresPlayable: boolean;
	blockedByActiveGeneration: boolean;
}

type ConversationCommandInput<K extends ConversationAction["type"]> = {
	conversationId: number;
} & Extract<ConversationAction, { type: K }>;

export const conversationCommandPolicy = {
	"create-message": {
		handler: createMessage,
		requiresPlayable: true,
		blockedByActiveGeneration: true,
	},
	"create-variant": {
		handler: createVariant,
		requiresPlayable: true,
		blockedByActiveGeneration: true,
	},
	"select-variant": {
		handler: selectVariant,
		requiresPlayable: false,
		blockedByActiveGeneration: false,
	},
	"edit-variant": {
		handler: editVariant,
		requiresPlayable: false,
		blockedByActiveGeneration: false,
	},
	"delete-variant": {
		handler: deleteVariant,
		requiresPlayable: false,
		blockedByActiveGeneration: false,
	},
	"delete-message": {
		handler: deleteMessage,
		requiresPlayable: false,
		blockedByActiveGeneration: false,
	},
	"add-participant": {
		handler: addParticipant,
		requiresPlayable: false,
		blockedByActiveGeneration: false,
	},
	"rename-participant": {
		handler: renameParticipant,
		requiresPlayable: false,
		blockedByActiveGeneration: false,
	},
	"replace-participant-prompt": {
		handler: replaceParticipantPrompt,
		requiresPlayable: false,
		blockedByActiveGeneration: false,
	},
	"replace-participant-openings": {
		handler: replaceParticipantOpenings,
		requiresPlayable: false,
		blockedByActiveGeneration: false,
	},
	"assign-control": {
		handler: assignControl,
		requiresPlayable: false,
		blockedByActiveGeneration: true,
	},
	"remove-participant": {
		handler: removeParticipant,
		requiresPlayable: false,
		blockedByActiveGeneration: false,
	},
	"put-data": {
		handler: putData,
		requiresPlayable: false,
		blockedByActiveGeneration: false,
	},
	"delete-data": {
		handler: deleteData,
		requiresPlayable: false,
		blockedByActiveGeneration: false,
	},
	"update-generation-settings": {
		handler: (db, input) => {
			updateConversationGenerationSettings(db, input.conversationId, input.settings);
		},
		requiresPlayable: false,
		blockedByActiveGeneration: false,
	},
	"set-generation-model": {
		handler: setGenerationModel,
		requiresPlayable: false,
		blockedByActiveGeneration: false,
	},
} satisfies {
	[K in ConversationAction["type"]]: ConversationCommandPolicy<K>;
};

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
		const policy = conversationCommandPolicy[command.action.type];
		if (
			policy.blockedByActiveGeneration &&
			hasActiveGeneration(database, command.conversationId)
		) {
			throw new InvalidConversationCommandError(
				"A new Conversation turn, Variant creation, or Control mutation is unavailable while an Active Generation exists.",
			);
		}
		if (
			policy.requiresPlayable &&
			!isPlayable(readControlAssignment(db, command.conversationId))
		) {
			throw new ConversationNotPlayableError(command.conversationId);
		}

		const input = { conversationId: command.conversationId, ...command.action };
		// ==[HUMAN APPROVED]== SAFETY: the `satisfies` clause on conversationCommandPolicy
		// guarantees each entry's handler accepts exactly its own command's
		// input shape, so indexing the table by input.type is sound; the cast
		// only recovers that correlation for the compiler.
		(
			conversationCommandPolicy[input.type] as ConversationCommandPolicy<
				typeof input.type
			>
		).handler(db, input);

		advanceConversationRevisionGuarded(
			db,
			command.conversationId,
			command.expectedRevision,
			conversation.revision,
		);
		return requireConversationSnapshot(db, command.conversationId);
	});
}
