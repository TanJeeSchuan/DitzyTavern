// @approved
//  What a Box's server files may use from the host, beside the shared entry.
export type { AdvanceResult, Box, BoxContext, BoxWindowRead, CaptureRead, DigestContext, DigestWindow } from "../server/box/contract";
export {
	InvalidConversationCommandError, conversationExists, readActiveVariantIds, readChatVariants, readConversationRevision, readExistingSources, readMessageAuthors,
	readParticipants,
} from "../server/conversation";
export { readMessageMoves } from "../server/box/moves";
export { effectiveRecord, hasAutomaticRecord, hasDigestError, readRecordSlots } from "../server/box/records";
export { readBoxLifecycles } from "../server/box/setup";
export { readBoxCatchUp } from "../server/box/digest";
export { readBoxDecision, readBoxDecisionSettings } from "../server/box/decision-settings";
export { putChatValue, putLibraryValue, readCharacterRevisions, readChatValue, readLibraryValue, readLibraryValues, readParticipantValues } from "../server/box/stored-value";
export { readProfileApiFormat } from "../server/connection-settings/persistence";
export { readEmbeddingConfiguration, type EmbeddingConfiguration } from "../server/box/embedding";
export { seededFraction } from "../server/box/seed";
export type { DecisionAnswer } from "../shared/contract/decision-model";
export { decisionRequest, largestFittingBatch, packDecisions } from "../server/decision-model";
export { cosineSimilarity } from "../server/model-client/embeddings";
export { tokenxEstimator } from "../server/prompt-compiler";
export { sha256 } from "../server/hash";
export { presentDomainError } from "../server/contract/domain-error";
