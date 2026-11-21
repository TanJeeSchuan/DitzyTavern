
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
export { acceptGeneration } from "./commands/accept-generation";
export { promptIntentOf, requireSiblingHistoricalControl, requireTerminalTarget } from "./generation-target";
export {
	checkpointConversationGeneration,
	checkpointUnstreamedOutcome,
	resolveConversationGeneration,
} from "./commands/active-generation";
// @approved
//  Derived targeted-Swipe rule shared by the snapshot and the sibling
// generation workflow so clients and transports never reproduce it.
export { deriveMessageSwipeEligibility } from "./snapshot";
export {
	DEFAULT_HISTORY_PAGE_SIZE,
	MAX_HISTORY_PAGE_SIZE,
	readChatHistory,
	readVariantText,
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
// @approved
//  The writer's Update check, for Creator Mode to run on a scenario's data
// in a database of its own, and the refusal an Update reads.
export { playedRefusals, refusedUpgrade } from "./box-upgrade";
export { readConversationRevision } from "./snapshot";
// @approved
//  The Workspace Chat list read model: the workspace route reads Chat
// summaries through the Conversation seam instead of querying its tables.
export { activeChatId, listChatSummaries } from "./chat-summaries";
export {
	cleanupRetainedGenerationInspections,
	GENERATION_REPLAY_RETENTION_MS,
	removeRetainedGenerationInspection,
} from "./generation-retention";
export type {
	CastParticipantSnapshot,
	AuthorStampSnapshot,
	GenerationAcceptanceCapture,
	CapturedGenerationTarget,
	AcceptedGeneration,
	ConversationAction,
	ConversationArtifactSeed,
	ConversationCommand,
	ConversationControlSeed,
	ConversationCreationInput,
	ConversationCreationMessage,
	ConversationCreationVariant,
	ConversationDataEntry,
	ConversationGenerationSettings,
	GenerationRecoveryCause,
	ConversationParticipantSeed,
	ConversationSummary,
	HistoricalControlSnapshot,
	MessageSwipeEligibility,
	ParticipantDefinition,
} from "./types";

export { authorRoleOf } from "./continuation";

export type { ConversationDatabase } from "./internal";
export { deleteConversation } from "./delete";
export type { SelectedHistoryRead } from "./selected-history";
export { createConversation } from "./create";
export { conversationExists, readConversationSummary, readConversationSummaryFromConnection } from "./snapshot";
export { readConversationGenerationSettings, readConversationGenerationSettingsFromConnection } from "./generation-settings";
export { readConversationPromptPreset } from "./prompt-preset";
export { readHistoryThroughVariant, readSelectedHistory, readSelectedHistoryFromConnection, readSelectedVariantIdsFromConnection } from "./selected-history";
export { readConversationData, readConversationDataBatch } from "./read-data";
export { editMacroVariables, readMacroVariables } from "./macro-variables";
export { stopConversationGeneration, stopConversationGenerations } from "./commands/active-generation";
export { runConversationReadTransaction } from "./commands/transaction";
export { findConversation, readActiveCast, readControlAssignment } from "./internal";
export { readChatVariantData, readActiveVariantIds, readChatVariantIds, readChatVariants, readExistingSources, readMessageAuthors, readParticipants, readSelectedPassages } from "./variant-read";

export { readActiveGenerationsForRecovery } from "./generation-details";

export type { GenerationRequestOverrides } from "./types";
export { DEFAULT_CONVERSATION_GENERATION_SETTINGS } from "./generation-settings";


export { readVariantData } from "./variant-data";

export { forkConversation } from "./commands/fork-conversation";
export { checkBoxValuesInChats } from "./box-values";

export { generationGate } from "./generation-gate";

export { readPaintPresetSelection, readPaintPresetSettings } from "./paint-preset";
export { readReferenceSets } from "./commands/update-reference-sets";
