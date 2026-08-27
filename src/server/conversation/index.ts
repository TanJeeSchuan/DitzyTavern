import type { Database } from "bun:sqlite";
import { commitConversationSiblingVariant } from "./commands/commit-sibling-variant";
import { commitConversationGeneration } from "./commands/commit-generation";
import {
	acceptConversationTailGeneration,
	acceptConversationContinuationGeneration,
	acceptConversationSiblingGeneration,
	checkpointConversationGeneration,
	removeConversationSiblingGeneration,
	removeConversationTailGeneration,
	stopConversationGeneration,
	resolveConversationSiblingGeneration,
	resolveConversationTailGeneration,
} from "./commands/active-generation";
import { createConversation } from "./create";
import { executeConversationCommand } from "./execute";
import { readChatHistory } from "./history";
import { connectConversationDatabase } from "./internal";
import { readConversationSnapshot } from "./snapshot";
import { readConversationData } from "./read-data";
import { readConversationGenerationSettings } from "./generation-settings";
import type { ConversationModule } from "./types";

export {
	ConversationNotPlayableError,
	ContinuationUnavailableError,
	ConversationNotFoundError,
	InvalidConversationCommandError,
	InvalidConversationCreationError,
	ParticipantNotRemovableError,
	SiblingVariantUnavailableError,
	ParticipantNotFoundError,
	StaleConversationRevisionError,
} from "./errors";
export type { ContinuationUnavailableReason } from "./errors";
export {
	DEFAULT_CONTINUATION_INSTRUCTION,
	DEFAULT_SAFETY_ALLOWANCE,
	DEFAULT_SIBLING_GENERATION_LIMIT,
} from "./generation-settings";
export {
	acceptConversationContinuationGeneration,
	acceptConversationTailGeneration,
	acceptConversationSiblingGeneration,
	checkpointConversationGeneration,
	checkpointConversationSiblingGeneration,
	checkpointConversationTailGeneration,
	removeConversationSiblingGeneration,
	removeConversationTailGeneration,
	stopConversationGeneration,
	resolveConversationSiblingGeneration,
	resolveConversationTailGeneration,
} from "./commands/active-generation";
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
	ActiveGenerationSnapshot,
	CapabilityBlockReason,
	CastParticipantSnapshot,
	AuthorStampSnapshot,
	ChatHistoryMessage,
	ChatHistoryPage,
	ChatHistoryPageRequest,
	ChatHistoryVariant,
	CommitGenerationInput,
	AcceptTailGenerationInput,
	AcceptedTailGeneration,
	AcceptContinuationGenerationInput,
	AcceptedContinuationGeneration,
	AcceptSiblingGenerationInput,
	AcceptedSiblingGeneration,
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
	ConversationJsonValue,
	ConversationDataRead,
	ConversationDataReadFilter,
	CheckpointGenerationInput,
	ConversationGenerationSettings,
	ConversationGenerationSettingsInput,
	ContinuationPrefillSuffix,
	RemoveTailGenerationInput,
	RemoveSiblingGenerationInput,
	StopGenerationInput,
	ResolveTailGenerationInput,
	ResolveSiblingGenerationInput,
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
		getGenerationSettings: (conversationId) => {
				const snapshot = readConversationSnapshot(
					connectConversationDatabase(database),
					conversationId,
				);
				if (snapshot === undefined) return undefined;
		return readConversationGenerationSettings(
					connectConversationDatabase(database),
					conversationId,
				);
			},
		readHistory: (conversationId, request) =>
			readChatHistory(connectConversationDatabase(database), conversationId, request),
		readConversationData: (conversationId, filter) =>
			readConversationData(
				connectConversationDatabase(database),
				conversationId,
				filter,
			),
		execute: (command) => executeConversationCommand(database, command),
		commitGeneration: (input) => commitConversationGeneration(database, input),
		acceptTailGeneration: (input) =>
			acceptConversationTailGeneration(database, input),
	acceptContinuationGeneration: (input) =>
			acceptConversationContinuationGeneration(database, input),
		acceptSiblingGeneration: (input) =>
		acceptConversationSiblingGeneration(database, input),
		checkpointGeneration: (input) =>
			checkpointConversationGeneration(database, input),
		resolveTailGeneration: (input) =>
			resolveConversationTailGeneration(database, input),
	removeTailGeneration: (input) =>
			removeConversationTailGeneration(database, input),
		stopGeneration: (input) =>
			stopConversationGeneration(database, input),
		resolveSiblingGeneration: (input) =>
			resolveConversationSiblingGeneration(database, input),
		removeSiblingGeneration: (input) =>
			removeConversationSiblingGeneration(database, input),
		commitSiblingVariant: (input) =>
			commitConversationSiblingVariant(database, input),
	};
}
