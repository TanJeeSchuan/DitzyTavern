import { Type, type Static } from "@sinclair/typebox";
import { numericWire } from "./wire";

export const memoryCandidate = Type.Object({
	claim: Type.String(), attribution: Type.String(), people: Type.Array(Type.String()),
	evidence: Type.Array(Type.Object({ messageId: Type.Integer(), excerpt: Type.String() })),
	judgment: Type.Object({ support: Type.Union([Type.Literal("supported"), Type.Literal("contradicted"), Type.Literal("not_established")]), usefulness: Type.Union([Type.Literal("retain"), Type.Literal("omit")]), probabilities: Type.Record(Type.String(), Type.Number()) }),
});
export const memoryCandidates = Type.Array(memoryCandidate);
export const memoryCollection = Type.Object({
	messageId: Type.Integer(), variantId: Type.Integer(), status: Type.Union([Type.Literal("unprocessed"), Type.Literal("stale"), Type.Literal("pending"), Type.Literal("running"), Type.Literal("complete"), Type.Literal("failed")]),
	error: Type.Union([Type.String(), Type.Null()]), revision: Type.Integer(), ownership: Type.Union([Type.Literal("automatic"), Type.Literal("writer")]), claims: Type.Array(memoryCandidate),
});
export const conversationMemories = Type.Object({ sources: Type.Array(memoryCollection) });
export type ConversationMemories = Static<typeof conversationMemories>;
export const memorySourceCommand = Type.Object({ messageId: Type.Integer() });
export const memoryConversationIdParams = Type.Object({ id: numericWire });
export const memoryQueueApplied = Type.Object({ outcome: Type.Literal("queued"), collection: memoryCollection });
export const memoryInvalid = Type.Object({ outcome: Type.Literal("invalid"), reason: Type.String() });

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
