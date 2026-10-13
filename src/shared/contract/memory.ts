import { Type, type Static } from "@sinclair/typebox";
import { boxCatchUp } from "./box-digest";
import { invalidOutcome } from "./outcomes";
import { numericWire } from "./wire";

// @approved
//  A Writer override reaches storage through `set-box-record`, so the record
// schema is what rejects a blank claim, attribution or person label.
const memoryText = Type.String({ minLength: 1, maxLength: 1024, pattern: "\\S" });
export const memoryCandidate = Type.Object({
	claim: memoryText, attribution: memoryText, people: Type.Array(Type.String({ pattern: "\\S" }), { uniqueItems: true }),
	evidence: Type.Array(Type.Object({ messageId: Type.Integer(), excerpt: Type.String({ maxLength: 1024 }) }), { maxItems: 3 }),
	judgment: Type.Object({ support: Type.Union([Type.Literal("supported"), Type.Literal("contradicted"), Type.Literal("not_established")]), attribution: Type.Union([Type.Literal("correct"), Type.Literal("misattributed"), Type.Literal("unclear")]), usefulness: Type.Union([Type.Literal("retain"), Type.Literal("omit")]), probabilities: Type.Record(Type.String(), Type.Number()), confidence: Type.Object({ support: Type.Optional(Type.Number()), attribution: Type.Optional(Type.Number()), usefulness: Type.Optional(Type.Number()) }) }),
	writerMaintained: Type.Optional(Type.Boolean()),
});
export type MemoryCandidateJudgment = Static<typeof memoryCandidate>;
/** @approved One Variant's Memory record: the claims its digest kept, or the Writer's whole corrected list. */
export const memoryRecord = Type.Object({ claims: Type.Array(memoryCandidate) });
export type MemoryRecord = Static<typeof memoryRecord>;
export const memoryIdentity = Type.Union([Type.Object({ kind: Type.Literal("themselves") }), Type.Object({ kind: Type.Literal("excluded") }), Type.Object({ kind: Type.Literal("plays"), person: Type.String({ minLength: 1, maxLength: 1024 }) })]);
export type MemoryIdentity = Static<typeof memoryIdentity>;
export const memoryIdentities = Type.Record(Type.String(), memoryIdentity);
export type MemoryIdentities = Static<typeof memoryIdentities>;
export const memoryIdentityCommand = Type.Object({ expectedRevision: Type.Integer(), participantId: Type.Integer(), identity: memoryIdentity });
export type MemoryIdentityCommand = Static<typeof memoryIdentityCommand>;
export const memoryLabelMerge = Type.Object({ from: Type.String(), to: Type.String() });
export type MemoryLabelMerge = Static<typeof memoryLabelMerge>;
export const memoryLabelMerges = Type.Array(memoryLabelMerge);
// @approved
//  One Variant as the Memories panel lists it: its effective claims as stored
// (labels apply when shown), whether a Writer override holds them, whether
// the automatic record is the one for exactly this text, and the error of a
// digest that failed on exactly this text.
export const memorySource = Type.Object({
	messageId: Type.Integer(), variantId: Type.Integer(), selected: Type.Boolean(),
	claims: Type.Union([Type.Array(memoryCandidate), Type.Null()]), overridden: Type.Boolean(), digested: Type.Boolean(), error: Type.Union([Type.String(), Type.Null()]),
});
export type MemorySourceView = Static<typeof memorySource>;
// @approved
//  `digestReady` reports whether Memory's Decision Model is selected and
// `embeddingReady` whether an embedding model is, without which no claim is
// recalled.
export const conversationMemories = Type.Object({
	revision: Type.Integer(), labelRevision: Type.Integer(), identities: memoryIdentities,
	cast: Type.Array(Type.Object({ id: Type.Integer(), names: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }) })),
	labelMerges: memoryLabelMerges, sources: Type.Array(memorySource),
	path: Type.Array(Type.Object({ messageId: Type.Integer(), author: Type.Union([Type.String(), Type.Null()]), authorParticipantId: Type.Union([Type.Integer(), Type.Null()]) })),
	digestReady: Type.Boolean(), embeddingReady: Type.Boolean(), catchUp: Type.Union([boxCatchUp, Type.Null()]),
});
export type ConversationMemories = Static<typeof conversationMemories>;
export const memoryLabelMergeCommand = Type.Object({ expectedRevision: Type.Integer(), labels: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }), destination: Type.String({ minLength: 1, maxLength: 1024 }) });
export type MemoryLabelMergeCommand = Static<typeof memoryLabelMergeCommand>;
export const memoryLabelsMerged = Type.Object({ outcome: Type.Literal("applied"), memories: conversationMemories });
export const memoryLabelsConflict = Type.Object({ outcome: Type.Literal("conflict"), memories: conversationMemories });
export const memoryConversationIdParams = Type.Object({ id: numericWire });

export const conversationMemoryAllowance = Type.Object({ revision: Type.Integer(), allowance: Type.Integer(), note: Type.String() });
export const conversationMemoryAllowanceCommand = Type.Object({ expectedRevision: Type.Integer(), allowance: Type.Integer() });
export const conversationMemoryNoteCommand = Type.Object({ expectedRevision: Type.Integer(), note: Type.String() });
export const conversationMemoryAllowanceApplied = Type.Object({ outcome: Type.Literal("applied"), settings: conversationMemoryAllowance });
export const conversationMemoryAllowanceConflict = Type.Object({ outcome: Type.Literal("conflict"), expectedRevision: Type.Integer(), actualRevision: Type.Integer(), currentSettings: conversationMemoryAllowance });
export type ConversationMemoryAllowance = Static<typeof conversationMemoryAllowance>;
// @approved
//  Memory's stored per-Chat values in conversation_data under `box:memory`;
// each key's row carries the revision.
export const memoryChatSettings = Type.Omit(conversationMemoryAllowance, ["revision"]);
export const memoryLabels = Type.Object({ identities: memoryIdentities, merges: memoryLabelMerges });

export const memoryExtractionResponse = Type.Object({
	candidates: Type.Array(Type.Object({
		claim: Type.String(), attribution: Type.String(), people: Type.Array(Type.String()),
		evidence: Type.Array(Type.Object({ messageId: Type.Integer(), excerpt: Type.String() }, { additionalProperties: false })),
	}, { additionalProperties: false }), { maxItems: 16 }),
}, { additionalProperties: false });
export type MemoryExtractionResponse = Static<typeof memoryExtractionResponse>;
export type MemoryCandidate = MemoryExtractionResponse["candidates"][number];
export type MemoryEvidence = MemoryCandidate["evidence"][number];
/** @approved A Message as extraction reads it: `speaker` is its captured author name. */
export type CapturedMemoryMessage = { readonly messageId: number; readonly speaker: string | null; readonly content: string };

// @approved
//  The Conversation memory command families' modeled error unions: the
// composed 409/422 envelopes each route declares, so the client decodes an
// error body against exactly the union its route models.
export const memoryLabelsCommandErrors = Type.Union([memoryLabelsConflict, invalidOutcome]);
export const memoryAllowanceCommandErrors = Type.Union([conversationMemoryAllowanceConflict, invalidOutcome]);
