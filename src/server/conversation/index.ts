import type { Database } from "bun:sqlite";
import { createConversation } from "./create";
import { executeConversationCommand } from "./execute";
import { connectConversationDatabase } from "./internal";
import { readConversationSnapshot } from "./snapshot";
import type { ConversationModule } from "./types";

export {
	ConversationNotPlayableError,
	ConversationNotFoundError,
	InvalidConversationCommandError,
	InvalidConversationCreationError,
	StaleConversationRevisionError,
} from "./errors";
export type {
	CapabilityAvailability,
	CapabilityBlockReason,
	CastParticipantSnapshot,
	AuthorStampSnapshot,
	ConversationAction,
	ConversationCapabilities,
	ConversationCommand,
	ConversationControlSeed,
	ConversationControlSnapshot,
	ConversationControlValidity,
	ConversationCreationInput,
	ConversationCreationMessage,
	ConversationCreationVariant,
	ConversationDataEntry,
	ConversationDataScope,
	ConversationMessageSnapshot,
	ConversationModule,
	ConversationParticipantSeed,
	ConversationSnapshot,
	ConversationVariantSnapshot,
	ControlValidityReason,
	HistoricalControlSnapshot,
	ParticipantDefinition,
	ParticipantDefinitionPrompt,
	ParticipantRemovalBlockReason,
	ParticipantRemovalEligibility,
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
