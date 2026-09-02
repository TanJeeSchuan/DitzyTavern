import type { Database } from "bun:sqlite";
import {
	acceptConversationTailGeneration,
	acceptConversationContinuationGeneration,
	acceptConversationSiblingGeneration,
} from "./commands/accept-generation";
import {
	checkpointConversationGeneration,
	removeConversationGeneration,
	stopConversationGeneration,
	stopConversationGenerations,
	resolveConversationSiblingGeneration,
	resolveConversationTailGeneration,
} from "./commands/active-generation";
import { createConversation } from "./create";
import { executeConversationCommand } from "./execute";
import { readChatHistory } from "./history";
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
} from "./generation-settings";
export { DEFAULT_SIBLING_GENERATION_LIMIT } from "./generation-defaults";
export {
	acceptConversationContinuationGeneration,
	acceptConversationTailGeneration,
	acceptConversationSiblingGeneration,
} from "./commands/accept-generation";
export {
	checkpointConversationGeneration,
	checkpointConversationSiblingGeneration,
	removeConversationGeneration,
	resolveConversationSiblingGeneration,
	resolveConversationTailGeneration,
} from "./commands/active-generation";
// ==[HUMAN APPROVED]== Derived targeted-Swipe rule shared by the snapshot and the sibling
// generation workflow so clients and transports never reproduce it.
export { deriveMessageSwipeEligibility } from "./snapshot";
// ==[HUMAN APPROVED]== Canonical persisted-intent reader shared by terminal commands and the
// recovery sweep so the sibling discriminator cannot drift between them.
export { isSiblingGenerationRow } from "./commands/active-generation";
// ==[HUMAN APPROVED]== The one Active-Generation existence probe, shared with the
// Generation-start capture workflows so no workflow re-probes the
// active_generation table through its own raw handle. The probe accepts the
// raw Database like every other public entry point, so workflows never
// construct the module's Drizzle handle.
export { hasActiveGeneration } from "./internal";
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
	AcceptTailGenerationInput,
	AcceptedTailGeneration,
	AcceptContinuationGenerationInput,
	AcceptedContinuationGeneration,
	AcceptSiblingGenerationInput,
	AcceptedSiblingGeneration,
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
	RemoveGenerationInput,
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
	ParticipantDeletionMode,
	ParticipantRemovalBlockReason,
	ParticipantRemovalEligibility,
} from "./types";

export function createConversationModule(database: Database): ConversationModule {
	return {
		create: (input) => createConversation(database, input),
		exists: (conversationId) => conversationExists(database, conversationId),
		getSnapshot: (conversationId) => readConversationSnapshot(database, conversationId),
		getGenerationSettings: (conversationId) =>
			readConversationGenerationSettings(database, conversationId),
		readHistory: (conversationId, request) =>
			readChatHistory(database, conversationId, request),
		readConversationData: (conversationId, filter) =>
			readConversationData(database, conversationId, filter),
		readActiveGenerationDetails: (conversationId, generationId) =>
			readActiveGenerationDetails(database, conversationId, generationId),
		readVariantDetails: (conversationId, messageId, variantId) =>
			readVariantDetails(database, conversationId, messageId, variantId),
		execute: (command) => executeConversationCommand(database, command),
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
	stopGeneration: (input) =>
		stopConversationGeneration(database, input),
	stopGenerations: (input) =>
		stopConversationGenerations(database, input),
		resolveSiblingGeneration: (input) =>
			resolveConversationSiblingGeneration(database, input),
		// ==[HUMAN APPROVED]== One canonical removal: the persisted Active Generation row decides
		// between the Sibling Variant and Tail/Continuation Message mutations.
		removeGeneration: (input) =>
			removeConversationGeneration(database, input),
	};
}
