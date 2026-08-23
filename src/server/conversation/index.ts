import type { Database } from "bun:sqlite";
import { commitConversationSiblingVariant } from "./commands/commit-sibling-variant";
import { commitConversationGeneration } from "./commands/commit-generation";
import { createConversation } from "./create";
import { executeConversationCommand } from "./execute";
import { readChatHistory } from "./history";
import { connectConversationDatabase } from "./internal";
import { readConversationSnapshot } from "./snapshot";
import type { ConversationModule } from "./types";

export {
	ConversationNotPlayableError,
	ConversationNotFoundError,
	InvalidConversationCommandError,
	InvalidConversationCreationError,
	ParticipantNotRemovableError,
	SiblingVariantUnavailableError,
	ParticipantNotFoundError,
	StaleConversationRevisionError,
} from "./errors";
// Derived targeted-Swipe rule shared by the snapshot and the sibling
// generation workflow so clients and transports never reproduce it.
export { deriveMessageSwipeEligibility } from "./snapshot";
export {
	DEFAULT_HISTORY_PAGE_SIZE,
	MAX_HISTORY_PAGE_SIZE,
	readChatHistory,
} from "./history";
export type {
	CapabilityAvailability,
	CapabilityBlockReason,
	CastParticipantSnapshot,
	AuthorStampSnapshot,
	ChatHistoryMessage,
	ChatHistoryPage,
	ChatHistoryPageRequest,
	ChatHistoryVariant,
	CommitGenerationInput,
	CommitSiblingVariantInput,
	ConversationAction,
	ConversationArtifactSeed,
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
	MessageSwipeBlockReason,
	MessageSwipeEligibility,
	ParticipantDefinition,
	ParticipantDefinitionPrompt,
	ParticipantDeletionMode,
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
		readHistory: (conversationId, request) =>
			readChatHistory(connectConversationDatabase(database), conversationId, request),
		execute: (command) => executeConversationCommand(database, command),
		commitGeneration: (input) => commitConversationGeneration(database, input),
		commitSiblingVariant: (input) =>
			commitConversationSiblingVariant(database, input),
	};
}
