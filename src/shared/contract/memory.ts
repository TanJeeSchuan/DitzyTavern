import { Type, type Static } from "@sinclair/typebox";
import { numericWire } from "./wire";

export const memoryCandidate = Type.Object({
	claim: Type.String(), attribution: Type.String(), people: Type.Array(Type.String()),
	evidence: Type.Array(Type.Object({ messageId: Type.Integer(), excerpt: Type.String() })),
	judgment: Type.Object({ support: Type.Union([Type.Literal("supported"), Type.Literal("contradicted"), Type.Literal("not_established")]), usefulness: Type.Union([Type.Literal("retain"), Type.Literal("omit")]), probabilities: Type.Record(Type.String(), Type.Number()) }),
	writerMaintained: Type.Optional(Type.Boolean()),
});
export const memoryCandidates = Type.Array(memoryCandidate);
export const memoryIndexing = Type.Object({
	status: Type.Union([Type.Literal("ready"), Type.Literal("pending"), Type.Literal("running"), Type.Literal("failed"), Type.Literal("disabled"), Type.Literal("unconfigured"), Type.Literal("not-applicable")]),
	pendingCount: Type.Integer(),
	failedCount: Type.Integer(),
	error: Type.Union([Type.String(), Type.Null()]),
});
export const memoryCollection = Type.Object({
	messageId: Type.Integer(), variantId: Type.Integer(), selected: Type.Boolean(), status: Type.Union([Type.Literal("unprocessed"), Type.Literal("stale"), Type.Literal("pending"), Type.Literal("running"), Type.Literal("complete"), Type.Literal("failed")]),
	error: Type.Union([Type.String(), Type.Null()]), revision: Type.Integer(), ownership: Type.Union([Type.Literal("automatic"), Type.Literal("writer")]), sourceChanged: Type.Boolean(), claims: Type.Array(memoryCandidate), indexing: memoryIndexing,
});
export const conversationMemories = Type.Object({ sources: Type.Array(memoryCollection) });
export type ConversationMemories = Static<typeof conversationMemories>;
export const memorySourceCommand = Type.Object({ messageId: Type.Integer() });
export const memoryConversationIdParams = Type.Object({ id: numericWire });
export const memoryQueueApplied = Type.Object({ outcome: Type.Literal("queued"), collection: memoryCollection });
export const memoryInvalid = Type.Object({ outcome: Type.Literal("invalid"), reason: Type.String() });
export const memoryCorrectionCommand = Type.Object({ messageId: Type.Integer(), variantId: Type.Integer(), expectedRevision: Type.Integer(), index: Type.Integer(), operation: Type.Union([Type.Literal("edit"), Type.Literal("remove")]), claim: Type.Optional(Type.String()), attribution: Type.Optional(Type.String()), people: Type.Optional(Type.Array(Type.String())) });
export const memoryCorrectionApplied = Type.Object({ outcome: Type.Literal("applied"), collection: memoryCollection });
export const memoryCorrectionConflict = Type.Object({ outcome: Type.Literal("conflict"), collection: memoryCollection });
export const memoryIndexRetryCommand = Type.Object({ messageId: Type.Integer(), variantId: Type.Integer(), expectedRevision: Type.Integer() });
export const memoryIndexRetryApplied = Type.Object({ outcome: Type.Literal("queued"), collection: memoryCollection });
export const memoryIndexRetryConflict = Type.Object({ outcome: Type.Literal("conflict"), collection: memoryCollection });
export const memoryCatchup = Type.Object({ id: Type.Integer(), state: Type.Union([Type.Literal("running"), Type.Literal("complete"), Type.Literal("failed"), Type.Literal("cancelled")]), pending: Type.Integer(), running: Type.Integer(), complete: Type.Integer(), failed: Type.Array(Type.Object({ messageId: Type.Integer(), error: Type.Union([Type.String(), Type.Null()]) })) });
export const memoryCatchupRead = Type.Object({ run: Type.Union([memoryCatchup, Type.Null()]) });
export const memoryCatchupCommand = Type.Object({});
export const memoryCatchupParams = Type.Object({ id: numericWire, runId: numericWire });
export type MemoryCatchup = Static<typeof memoryCatchup>;

export const conversationMemoryAllowance = Type.Object({ revision: Type.Integer(), allowance: Type.Integer(), enabled: Type.Boolean() });
export const conversationMemoryAllowanceCommand = Type.Object({ expectedRevision: Type.Integer(), allowance: Type.Integer() });
export const conversationMemoryAllowanceApplied = Type.Object({ outcome: Type.Literal("applied"), settings: conversationMemoryAllowance });
export const conversationMemoryAllowanceConflict = Type.Object({ outcome: Type.Literal("conflict"), expectedRevision: Type.Integer(), actualRevision: Type.Integer(), currentSettings: conversationMemoryAllowance });
export const conversationMemoryAllowanceInvalid = Type.Object({ outcome: Type.Literal("invalid"), reason: Type.String() });
export type ConversationMemoryAllowance = Static<typeof conversationMemoryAllowance>;

export const memoryExtractionResponse = Type.Object({
	candidates: Type.Array(Type.Object({
		claim: Type.String(), attribution: Type.String(), people: Type.Array(Type.String()),
		evidence: Type.Array(Type.Object({ messageId: Type.Integer(), excerpt: Type.String() }, { additionalProperties: false })),
	}, { additionalProperties: false }), { maxItems: 16 }),
}, { additionalProperties: false });
export const memoryJudgmentAnswer = Type.Object({
	type: Type.Literal("choice"), choice: Type.String(), probabilities: Type.Record(Type.String(), Type.Number()),
}, { additionalProperties: false });
export const memoryJudgmentResponse = Type.Object({ answers: Type.Record(Type.String(), memoryJudgmentAnswer) }, { additionalProperties: false });
export type MemoryExtractionResponse = Static<typeof memoryExtractionResponse>;
export type MemoryJudgmentAnswer = Static<typeof memoryJudgmentAnswer>;
export type MemoryJudgmentResponse = Static<typeof memoryJudgmentResponse>;
export const memoryCapturedMessage = Type.Object({ messageId: Type.Integer(), variantId: Type.Integer(), content: Type.String() });
export const memoryWorkSnapshot = Type.Object({ source: memoryCapturedMessage, context: Type.Array(memoryCapturedMessage) });
export type MemoryWorkSnapshot = Static<typeof memoryWorkSnapshot>;
