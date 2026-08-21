import type { Database } from "bun:sqlite";
import { createConversation } from "./create";
import { executeConversationCommand } from "./execute";
import { connectConversationDatabase } from "./internal";
import { readConversationSnapshot } from "./snapshot";
import type { ConversationModule } from "./types";

export {
	ConversationNotFoundError,
	InvalidConversationCommandError,
	InvalidConversationCreationError,
	StaleConversationRevisionError,
} from "./errors";
export type {
	ConversationAction,
	ConversationCommand,
	ConversationCreationInput,
	ConversationCreationMessage,
	ConversationCreationVariant,
	ConversationDataEntry,
	ConversationDataScope,
	ConversationMessageSnapshot,
	ConversationModule,
	ConversationSnapshot,
	ConversationVariantSnapshot,
} from "./types";

export function createConversationModule(database: Database): ConversationModule {
	return {
		create: (input) => createConversation(database, input),
		getSnapshot: (conversationId) =>
			readConversationSnapshot(
				connectConversationDatabase(database),
				conversationId,
			),
		execute: (command) => executeConversationCommand(database, command),
	};
}
