
export {
	ConversationNotPlayableError,
	ConversationWriteObserverMissingError,
	ContinuationUnavailableError,
	ConversationNotFoundError,
	InvalidConversationCommandError,
	InvalidConversationCreationError,
	ParticipantNotRemovableError,
	SiblingVariantUnavailableError,
	ParticipantNotFoundError,
} from "./errors";
export type { ContinuationUnavailableReason } from "./errors";
export {
	DEFAULT_CONTINUATION_INSTRUCTION,
	DEFAULT_SAFETY_ALLOWANCE,
} from "./generation-settings";
export { DEFAULT_SIBLING_GENERATION_LIMIT } from "../database/schema";
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
// @approved
//  Derived targeted-Swipe rule shared by the snapshot and the sibling
// generation workflow so clients and transports never reproduce it.
export { deriveMessageSwipeEligibility } from "./snapshot";
// @approved
//  Canonical persisted-intent reader shared by terminal commands and the
// recovery sweep so the sibling discriminator cannot drift between them.
export { isSiblingGenerationRow } from "./commands/active-generation";
// @approved
//  The one Active-Generation existence probe, shared with the
// Generation-start capture workflows so no workflow re-probes the
// active_generation table through its own raw handle. The probe accepts the
// raw Database like every other public entry point, so workflows never
// construct the module's Drizzle handle.
export {
	DEFAULT_HISTORY_PAGE_SIZE,
	MAX_HISTORY_PAGE_SIZE,
	readChatHistory,
} from "./history";
// @approved
//  The application-installed write observer: app.ts hands Memory's
// sync to this seam so the deep Conversation module reports what it changed
// instead of importing Memory.
export { observeConversationWrites } from "./commands/transaction";
// @approved
//  The canonical revisioned command seam: the Lorebook attachment
// route dispatches its Conversation-owned commands through it instead of
// keeping a parallel write transaction.
export { executeConversationCommand } from "./execute";
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
	ConversationParticipantSeed,
	ConversationSummary,
	ControlValidityReason,
	HistoricalControlSnapshot,
	MessageSwipeBlockReason,
	MessageSwipeEligibility,
	ParticipantDefinition,
	ParticipantDeletionMode,
	ParticipantRemovalBlockReason,
	ParticipantRemovalEligibility,
} from "./types";

export { authorRoleOf, continuationEligibility } from "./continuation";

export type { ConversationDatabase } from "./internal";
export { attachConversationLorebook, saveConversationLoreSettings } from "./commands/lore-attachments";
export { deleteConversation } from "./delete";
export type { EditMacroVariablesInput, EditedMacroVariables, ReadMacroVariablesInput } from "./macro-variables";
export type { SelectedHistoryMessage, SelectedHistoryRead, SelectedHistoryReadRequest, SelectedHistoryVariant } from "./selected-history";
export { createConversation } from "./create";
export { conversationExists, readConversationSummary, readConversationSummaryFromConnection } from "./snapshot";
export { readConversationGenerationSettings, readConversationGenerationSettingsFromConnection } from "./generation-settings";
export { readConversationPromptPreset } from "./prompt-preset";
export { readSelectedHistory, readSelectedHistoryFromConnection } from "./selected-history";
export { readConversationData } from "./read-data";
export { editMacroVariables, readMacroVariables } from "./macro-variables";
export { stopConversationGeneration, stopConversationGenerations } from "./commands/active-generation";
export { runConversationReadTransaction } from "./commands/transaction";
export { readMemorySourceAvailability } from "./generation-details";
export { findConversation, readActiveCast, readControlAssignment } from "./internal";
export { readActiveVariantIds, readMessageAuthorsForMemory, readMemoryTailMessageId, readSelectedPathForMemory, readVariantsForMemory } from "./memory-read";
export type { MemorySourceVariant } from "./memory-read";

export { readActiveGenerationsForRecovery } from "./generation-details";

export type { GenerationRequestOverrides } from "./types";
export { DEFAULT_CONVERSATION_GENERATION_SETTINGS } from "./generation-settings";

export { loadMessageRows } from "./message-rows";

export { readVariantData } from "./variant-data";
export type { VariantDataRecords } from "./variant-data";
