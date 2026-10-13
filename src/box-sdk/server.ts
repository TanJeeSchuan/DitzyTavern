// @approved
//  What a Box's server files may use from the host, beside the shared entry.
export type { AdvanceResult, Box, MemoryRecall } from "../server/box/contract";
export { readConversationSummaryFromConnection, readSelectedHistoryFromConnection, runConversationReadTransaction, InvalidConversationCommandError } from "../server/conversation";
export { humanMessageText, readMessageMoves } from "../server/box/moves";
export { foldRecords, readRecordSlots } from "../server/box/records";
export { readBoxInstances } from "../server/box/setup";
export { seededFraction } from "../server/box/seed";
export { boxReference } from "../shared/contract/box";
export type { DecisionAnswer } from "../shared/contract/decision-model";
export { characterDataTable, libraryDataTable, participantDataTable } from "../server/database/schema";

// @approved
//  Memory's domain stays in-tree (ADR-0050); only its Box adapter uses these.
export { memoryActivationRecord, type MemoryActivationRecord } from "../shared/contract/memory-recall";
export type { MemoryRecord } from "../shared/contract/memory";
export { renderMemoryClaim } from "../shared/memory-text";
export { digestMemory } from "../server/memory/extraction";
