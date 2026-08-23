import type { Database } from "bun:sqlite";
import { commitConversationSiblingVariant } from "./commands/commit-sibling-variant";
import { commitConversationGeneration } from "./commands/commit-generation";
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
	SiblingVariantUnavailableError,
	StaleConversationRevisionError,
} from "./errors";
// Derived targeted-Swipe rule shared by the snapshot and the sibling
// generation workflow so clients and transports never reproduce it.
export { deriveMessageSwipeEligibility } from "./snapshot";
export type {
	CapabilityAvailability,
	CapabilityBlockReason,
	CastParticipantSnapshot,
	AuthorStampSnapshot,
	CommitGenerationInput,
	CommitSiblingVariantInput,
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
	MessageSwipeBlockReason,
	MessageSwipeEligibility,
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
		commitGeneration: (input) => commitConversationGeneration(database, input),
		commitSiblingVariant: (input) =>
			commitConversationSiblingVariant(database, input),
	};
}
