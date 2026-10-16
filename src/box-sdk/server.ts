// @approved
//  What a Box's server files may use from the host, beside the shared entry.
export type { AdvanceResult, Box, BoxContext, CaptureRead, DigestContext, DigestWindow } from "../server/box/contract";
export {
	readConversationSummaryFromConnection, readSelectedHistoryFromConnection, runConversationReadTransaction, InvalidConversationCommandError,
	conversationExists, readActiveVariantIds, readChatVariants, readConversationRevision, readExistingSources, readMessageAuthors, readParticipants,
} from "../server/conversation";
export { humanMessageText, readMessageMoves } from "../server/box/moves";
export { effectiveRecord, foldRecords, hasAutomaticRecord, hasDigestError, readRecordSlots } from "../server/box/records";
export { readBoxInstances } from "../server/box/setup";
export { readBoxCatchUp } from "../server/box/digest";
export { readBoxDecision, readBoxDecisionSettings } from "../server/box/decision-settings";
export { putChatValue, putLibraryValue, readChatValue, readLibraryValue } from "../server/box/stored-value";
export { readEmbeddingConfiguration, type EmbeddingConfiguration } from "../server/box/embedding";
export { seededFraction } from "../server/box/seed";
export { boxReference } from "../shared/contract/box";
export type { DecisionAnswer } from "../shared/contract/decision-model";
export { decisionRequest, largestFittingBatch, packDecisions } from "../server/decision-model";
export { cosineSimilarity } from "../server/model-client/embeddings";
export { tokenxEstimator } from "../server/prompt-compiler";
export { sha256 } from "../server/hash";
export { presentDomainError } from "../server/contract/domain-error";
export { characterDataTable, connectionProfileTable, libraryDataTable, participantDataTable } from "../server/database/schema";

export { openInitializedDatabase } from "../server/database/database";
export { uploadImage } from "../server/image";
export { ingestImage } from "../server/image/ingest";
