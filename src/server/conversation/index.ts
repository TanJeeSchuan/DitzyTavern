import type { Database } from "bun:sqlite";
import { executeConversationCommand } from "./execute";
import { connectConversationDatabase } from "./internal";
import { readConversationSnapshot } from "./snapshot";
import type { ConversationModule } from "./types";

export {
	ConversationNotFoundError,
	InvalidConversationCommandError,
	StaleConversationRevisionError,
} from "./errors";
export type {
	ConversationAction,
	ConversationCommand,
	ConversationDataEntry,
	ConversationDataScope,
	ConversationMessageSnapshot,
	ConversationModule,
	ConversationSnapshot,
	ConversationVariantSnapshot,
} from "./types";

export function createConversationModule(database: Database): ConversationModule {
	return {
		getSnapshot: (conversationId) =>
			readConversationSnapshot(
				connectConversationDatabase(database),
				conversationId,
			),
		execute: (command) => executeConversationCommand(database, command),
	};
}
