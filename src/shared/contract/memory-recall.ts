import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const MEMORY_ACTIVATION_NAMESPACE = "generation-memory";
export const MEMORY_ACTIVATION_KEY = "activation";

export const memoryRelevanceScore = Type.Union([
	Type.Literal("irrelevant"),
	Type.Literal("incidental"),
	Type.Literal("useful"),
	Type.Literal("central"),
]);

export const memoryAdmissionReason = Type.Union([
	Type.Literal("admitted"),
	Type.Literal("not-retained"),
	Type.Literal("duplicate-rendering"),
	Type.Literal("allowance"),
	Type.Literal("oversized"),
	Type.Literal("context-limit"),
	Type.Literal("request-limit"),
]);

export const memoryRecallCandidate = Type.Object({
	identity: Type.String(),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
	collectionRevision: Type.Integer(),
	ownership: Type.Union([Type.Literal("automatic"), Type.Literal("writer")]),
	sourceChanged: Type.Boolean(),
	claimIndex: Type.Integer(),
	claim: Type.String({ maxLength: 1024 }),
	attribution: Type.String({ maxLength: 1024 }),
	people: Type.Array(Type.String()),
	evidence: Type.Array(Type.Object({ messageId: Type.Integer(), excerpt: Type.String({ maxLength: 1024 }) }), { maxItems: 3 }),
	sourcePosition: Type.Integer(),
	semanticSimilarity: Type.Union([Type.Number(), Type.Null()]),
	semanticRank: Type.Union([Type.Integer(), Type.Null()]),
	recentRank: Type.Union([Type.Integer(), Type.Null()]),
	relevance: Type.Union([memoryRelevanceScore, Type.Null()]),
	relevanceScore: Type.Union([Type.Number(), Type.Null()]),
	admission: memoryAdmissionReason,
});

export const memoryActivationRecord = Type.Object({
	version: Type.Literal(1),
	state: Type.Union([
		Type.Literal("disabled"),
		Type.Literal("allowance-zero"),
		Type.Literal("empty"),
		Type.Literal("rebuilding"),
		Type.Literal("partial"),
		Type.Literal("ready"),
		Type.Literal("index-failed"),
		Type.Literal("source-failed"),
		Type.Literal("unconfigured"),
	]),
	allowance: Type.Integer(),
	eligibleSourceCount: Type.Integer(),
	readyRecordCount: Type.Integer(),
	embeddingModel: Type.String(),
	embeddingDeadlineMs: Type.Integer(),
	jevModel: Type.String(),
	jevConfigured: Type.Boolean(),
	relevanceMinimum: Type.Number(),
	pendingSourceCount: Type.Integer(),
	pendingIndexCount: Type.Integer(),
	failedIndexCount: Type.Integer(),
	failedSourceCount: Type.Integer(),
	sourceSnapshotFingerprint: Type.String(),
	embeddingConfigurationFingerprint: Type.String(),
	scanMessageIds: Type.Array(Type.Integer()),
	scanTruncated: Type.Boolean(),
	scene: Type.String(),
	semanticShortlistCount: Type.Integer(),
	recentShortlistCount: Type.Integer(),
	candidates: Type.Array(memoryRecallCandidate, { maxItems: 64 }),
	automaticMemoryText: Type.String(),
	finalMemoryText: Type.String(),
	manuallyEdited: Type.Boolean(),
});

export type MemoryActivationRecord = Static<typeof memoryActivationRecord>;

export const memoryActivationWithFinalText = (
	source: MemoryActivationRecord,
	finalMemoryText: string,
): MemoryActivationRecord => ({
	...source,
	finalMemoryText,
	manuallyEdited: finalMemoryText !== source.automaticMemoryText,
});

export class MemoryActivationRecordParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MemoryActivationRecordParseError";
	}
}

export type MemoryRelevanceScore = Static<typeof memoryRelevanceScore>;
export type MemoryAdmissionReason = Static<typeof memoryAdmissionReason>;
export type MemoryRecallCandidateRecord = Static<typeof memoryRecallCandidate>;

export const isMemoryActivationRecord = (value: unknown): value is MemoryActivationRecord =>
	Value.Check(memoryActivationRecord, value);

export const parseMemoryActivationRecord = (serialized: string): MemoryActivationRecord | null => {
	let parsed: unknown;
	try { parsed = JSON.parse(serialized); } catch { throw new MemoryActivationRecordParseError("Persisted Memory Activation Record is not valid JSON."); }
	if (parsed === null) return null;
	try { return Value.Parse(memoryActivationRecord, parsed); } catch { throw new MemoryActivationRecordParseError("Persisted Memory Activation Record does not match its schema."); }
};
