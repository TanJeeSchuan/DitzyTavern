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
	resolveConversationGeneration,
} from "./commands/active-generation";
import { createConversation } from "./create";
export { deleteConversation } from "./delete";
import { executeConversationCommand } from "./execute";
import { readChatHistory } from "./history";
import {
	conversationExists,
	readConversationRevision,
	readConversationSnapshot,
	readConversationSummary,
} from "./snapshot";
import { readConversationData } from "./read-data";
import { readSelectedHistory } from "./selected-history";
import { readConversationPromptPreset } from "./prompt-preset";
import {
	readActiveGenerationDetails,
	readVariantDetails,
} from "./generation-details";
import { readConversationGenerationSettings } from "./generation-settings";
import {
	editMacroVariables,
	readMacroVariables,
} from "./macro-variables";
export type {
	EditMacroVariablesInput,
	EditedMacroVariables,
	ReadMacroVariablesInput,
} from "./macro-variables";
export type {
	SelectedHistoryMessage,
	SelectedHistoryRead,
	SelectedHistoryReadRequest,
	SelectedHistoryVariant,
} from "./selected-history";
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
	removeConversationGeneration,
	resolveConversationGeneration,
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
// ==[HUMAN APPROVED]== The application-installed write observer: app.ts hands Memory's
// sync to this seam so the deep Conversation module reports what it changed
// instead of importing Memory.
export { observeConversationWrites } from "./commands/transaction";
export { readActiveGenerationDetails, readVariantDetails } from "./generation-details";
export { readConversationRevision } from "./snapshot";
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
	MacroVariables,
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
	ResolveGenerationInput,
	ConversationDataScope,
	ConversationMessageSnapshot,
	ConversationModule,
	ConversationParticipantSeed,
	ConversationSnapshot,
	ConversationSummary,
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
		getRevision: (conversationId) => readConversationRevision(database, conversationId),
		getSnapshot: (conversationId) => readConversationSnapshot(database, conversationId),
		getSummary: (conversationId) => readConversationSummary(database, conversationId),
		getGenerationSettings: (conversationId) =>
			readConversationGenerationSettings(database, conversationId),
		getPromptPreset: (conversationId) =>
			readConversationPromptPreset(database, conversationId),
		readHistory: (conversationId, request) =>
			readChatHistory(database, conversationId, request),
		readConversationData: (conversationId, filter) =>
			readConversationData(database, conversationId, filter),
		readSelectedHistory: (conversationId, request) =>
			readSelectedHistory(database, conversationId, request),
		readMacroVariables: (conversationId, input) =>
			readMacroVariables(database, conversationId, input),
		editMacroVariables: (input) => editMacroVariables(database, input),
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
		resolveGeneration: (input) =>
			resolveConversationGeneration(database, input),
		stopGeneration: (input) =>
			stopConversationGeneration(database, input),
		stopGenerations: (input) =>
			stopConversationGenerations(database, input),
		// ==[HUMAN APPROVED]== One canonical removal: the persisted Active Generation row decides
		// between the Sibling Variant and Tail/Continuation Message mutations.
		removeGeneration: (input) =>
			removeConversationGeneration(database, input),
	};
}
