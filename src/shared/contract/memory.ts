import { Type, type Static } from "@sinclair/typebox";
import { numericWire } from "./wire";

export const memoryCandidate = Type.Object({
	claim: Type.String(), attribution: Type.String(), people: Type.Array(Type.String()),
	evidence: Type.Array(Type.Object({ messageId: Type.Integer(), excerpt: Type.String() })),
	judgment: Type.Object({ support: Type.Union([Type.Literal("supported"), Type.Literal("contradicted"), Type.Literal("not_established")]), attribution: Type.Union([Type.Literal("correct"), Type.Literal("misattributed"), Type.Literal("unclear")]), usefulness: Type.Union([Type.Literal("retain"), Type.Literal("omit")]), probabilities: Type.Record(Type.String(), Type.Number()), confidence: Type.Object({ support: Type.Number(), attribution: Type.Number(), usefulness: Type.Number() }) }),
	writerMaintained: Type.Optional(Type.Boolean()),
});
export type MemoryCandidateJudgment = Static<typeof memoryCandidate>;
export const memoryCandidates = Type.Array(memoryCandidate);
export const memoryIndexing = Type.Object({
	status: Type.Union([Type.Literal("ready"), Type.Literal("pending"), Type.Literal("running"), Type.Literal("failed"), Type.Literal("disabled"), Type.Literal("unconfigured"), Type.Literal("not-applicable")]),
	pendingCount: Type.Integer(),
	failedCount: Type.Integer(),
	error: Type.Union([Type.String(), Type.Null()]),
});
export type MemoryIndexReadiness = Static<typeof memoryIndexing>;
export const memoryCollection = Type.Object({
	messageId: Type.Integer(), variantId: Type.Integer(), selected: Type.Boolean(), status: Type.Union([Type.Literal("unprocessed"), Type.Literal("stale"), Type.Literal("pending"), Type.Literal("running"), Type.Literal("complete"), Type.Literal("failed")]),
	error: Type.Union([Type.String(), Type.Null()]), revision: Type.Integer(), ownership: Type.Union([Type.Literal("automatic"), Type.Literal("writer")]), sourceChanged: Type.Boolean(), claims: Type.Array(memoryCandidate), indexing: memoryIndexing,
});
export type MemoryCollectionView = Static<typeof memoryCollection>;
export const conversationMemories = Type.Object({ sources: Type.Array(memoryCollection), path: Type.Array(Type.Object({ messageId: Type.Integer(), author: Type.Union([Type.String(), Type.Null()]) })) });
export type ConversationMemories = Static<typeof conversationMemories>;
export const memoryConversationIdParams = Type.Object({ id: numericWire });
export const memoryInvalid = Type.Object({ outcome: Type.Literal("invalid"), reason: Type.String() });
export const memoryResetCommand = Type.Object({ messageId: Type.Integer(), variantId: Type.Integer(), expectedRevision: Type.Integer() });
export const memoryQueued = Type.Object({ outcome: Type.Literal("queued"), collection: memoryCollection });
export const memoryCollectionConflict = Type.Object({ outcome: Type.Literal("conflict"), collection: memoryCollection });
const memoryCorrectionTarget = { messageId: Type.Integer(), variantId: Type.Integer(), expectedRevision: Type.Integer(), index: Type.Integer() };
export const memoryCorrectionCommand = Type.Union([
	Type.Object({ ...memoryCorrectionTarget, operation: Type.Literal("edit"), claim: Type.String(), attribution: Type.String(), people: Type.Array(Type.String()) }),
	Type.Object({ ...memoryCorrectionTarget, operation: Type.Literal("remove") }),
]);
export type MemoryCorrectionCommand = Static<typeof memoryCorrectionCommand>;
export const memoryCorrectionApplied = Type.Object({ outcome: Type.Literal("applied"), collection: memoryCollection });
export const memoryIndexRetryCommand = Type.Object({ messageId: Type.Integer(), variantId: Type.Integer(), expectedRevision: Type.Integer() });
export const memoryCatchup = Type.Object({ id: Type.Integer(), state: Type.Union([Type.Literal("running"), Type.Literal("complete"), Type.Literal("failed"), Type.Literal("cancelled")]), pending: Type.Integer(), running: Type.Integer(), complete: Type.Integer(), failed: Type.Array(Type.Object({ messageId: Type.Integer(), error: Type.Union([Type.String(), Type.Null()]) })) });
export const memoryCatchupRead = Type.Object({ run: Type.Union([memoryCatchup, Type.Null()]) });
export const memoryCatchupCommand = Type.Object({});
export const memoryCatchupParams = Type.Object({ id: numericWire, runId: numericWire });
export type MemoryCatchup = Static<typeof memoryCatchup>;

export const conversationMemoryAllowance = Type.Object({ revision: Type.Integer(), allowance: Type.Integer(), enabled: Type.Boolean() });
export const conversationMemoryAllowanceCommand = Type.Object({ expectedRevision: Type.Integer(), allowance: Type.Integer() });
export const conversationMemoryAllowanceApplied = Type.Object({ outcome: Type.Literal("applied"), settings: conversationMemoryAllowance });
export const conversationMemoryAllowanceConflict = Type.Object({ outcome: Type.Literal("conflict"), expectedRevision: Type.Integer(), actualRevision: Type.Integer(), currentSettings: conversationMemoryAllowance });
export type ConversationMemoryAllowance = Static<typeof conversationMemoryAllowance>;

export const memoryExtractionResponse = Type.Object({
	candidates: Type.Array(Type.Object({
		claim: Type.String(), attribution: Type.String(), people: Type.Array(Type.String()),
		evidence: Type.Array(Type.Object({ messageId: Type.Integer(), excerpt: Type.String() }, { additionalProperties: false })),
	}, { additionalProperties: false }), { maxItems: 16 }),
}, { additionalProperties: false });
export type MemoryExtractionResponse = Static<typeof memoryExtractionResponse>;
export type MemoryCandidate = MemoryExtractionResponse["candidates"][number];
export type MemoryEvidence = MemoryCandidate["evidence"][number];
export const memoryCapturedMessage = Type.Object({ messageId: Type.Integer(), variantId: Type.Integer(), content: Type.String() });
export type CapturedMemoryMessage = Static<typeof memoryCapturedMessage>;
export const memoryWorkSnapshot = Type.Object({ source: memoryCapturedMessage, context: Type.Array(memoryCapturedMessage) });
export type MemoryWorkSnapshot = Static<typeof memoryWorkSnapshot>;
export const memoryTraceSteps = Type.Array(Type.Object({ label: Type.String(), at: Type.String(), fields: Type.Record(Type.String(), Type.String()) }));
export type MemoryTraceStep = Static<typeof memoryTraceSteps>[number];
export const memoryTraceParams = Type.Object({ id: numericWire, variantId: numericWire });
export const memoryTrace = Type.Object({ steps: memoryTraceSteps });
