import type { Database } from "bun:sqlite";
import { commitConversationSiblingVariant } from "./commands/commit-sibling-variant";
import { commitConversationGeneration } from "./commands/commit-generation";
import {
	acceptConversationTailGeneration,
	acceptConversationContinuationGeneration,
	acceptConversationSiblingGeneration,
} from "./commands/accept-generation";
import {
	checkpointConversationGeneration,
	removeConversationSiblingGeneration,
	removeConversationTailGeneration,
	stopConversationGeneration,
	stopConversationGenerations,
	resolveConversationSiblingGeneration,
	resolveConversationTailGeneration,
} from "./commands/active-generation";
import { createConversation } from "./create";
import { executeConversationCommand } from "./execute";
import { readChatHistory } from "./history";
import { connectConversationDatabase } from "./internal";
import { conversationExists, readConversationSnapshot } from "./snapshot";
import { readConversationData } from "./read-data";
import {
	readActiveGenerationDetails,
	readVariantDetails,
} from "./generation-details";
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
} from "./commands/accept-generation";
export {
	checkpointConversationGeneration,
	checkpointConversationSiblingGeneration,
	checkpointConversationTailGeneration,
	removeConversationSiblingGeneration,
	removeConversationTailGeneration,
	stopConversationGeneration,
	stopConversationGenerations,
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
export { readActiveGenerationDetails, readVariantDetails } from "./generation-details";
export {
	cleanupRetainedGenerationInspections,
	GENERATION_REPLAY_RETENTION_MS,
	removeRetainedGenerationInspection,
} from "./generation-retention";
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
	ActiveGenerationDetails,
	GenerationProvenance,
	VariantDetails,
	CheckpointGenerationInput,
	ConversationGenerationSettings,
	ConversationGenerationSettingsInput,
	ContinuationPrefillSuffix,
	RemoveTailGenerationInput,
	RemoveSiblingGenerationInput,
	StopGenerationInput,
	StopGenerationsInput,
	StoppedGenerations,
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
		exists: (conversationId) =>
			conversationExists(connectConversationDatabase(database), conversationId),
		getSnapshot: (conversationId) =>
			readConversationSnapshot(
				connectConversationDatabase(database),
				conversationId,
			),
		getGenerationSettings: (conversationId) => {
			const db = connectConversationDatabase(database);
			if (!conversationExists(db, conversationId)) return undefined;
			return readConversationGenerationSettings(db, conversationId);
		},
		readHistory: (conversationId, request) =>
			readChatHistory(connectConversationDatabase(database), conversationId, request),
		readConversationData: (conversationId, filter) =>
			readConversationData(
				connectConversationDatabase(database),
				conversationId,
				filter,
			),
		readActiveGenerationDetails: (conversationId, generationId) =>
			readActiveGenerationDetails(
				connectConversationDatabase(database),
				conversationId,
				generationId,
			),
		readVariantDetails: (conversationId, messageId, variantId) =>
			readVariantDetails(
				connectConversationDatabase(database),
				conversationId,
				messageId,
				variantId,
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
	stopGenerations: (input) =>
		stopConversationGenerations(database, input),
		resolveSiblingGeneration: (input) =>
			resolveConversationSiblingGeneration(database, input),
		removeSiblingGeneration: (input) =>
			removeConversationSiblingGeneration(database, input),
		commitSiblingVariant: (input) =>
			commitConversationSiblingVariant(database, input),
	};
}
