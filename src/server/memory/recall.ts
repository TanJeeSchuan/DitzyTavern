import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import { sliceByTokens } from "tokenx";
import { memoryCandidates } from "../../shared/contract/memory";
import type { MemoryActivationRecord, MemoryRecallCandidateRecord } from "../../shared/contract/memory-recall";
import { renderMemoryClaim } from "../../shared/memory-text";
import { activeGenerationTable, memoryCollectionTable } from "../database/schema";
import { createMemorySettingsModule } from "./settings";
import { createTypesafeSettingsModule, jevRequest, requestJev } from "../typesafe";
import { cosineSimilarity } from "../model-client/embeddings";
import { tokenxEstimator } from "../prompt-compiler";
import type { ModelFetch } from "../model-client/types";
import { embedMemoryQuery, readCachedMemoryVectors, readMemoryEmbeddingConfiguration, readMemoryIndexReadinessBatch, type MemoryEmbeddingConfiguration } from "./indexing";
import { readMemoryAllowance } from "./collections";
import { sha256 } from "./hash";
import type { MemoryCandidateJudgment } from "../../shared/contract/memory";
import type { JevAnswer } from "../../shared/contract/typesafe";

export interface MemoryRecallSceneMessage {
	readonly messageId: number;
	readonly variantId: number;
	readonly position: number;
	readonly speakerName: string | null;
	readonly role: "human" | "model" | null;
	readonly content: string;
}

interface IndexedMemoryCandidate {
	readonly record: Omit<MemoryRecallCandidateRecord, "semanticSimilarity" | "semanticRank" | "recentRank" | "judged" | "relevance" | "relevanceScore" | "retained" | "requestIncluded" | "admission">;
	readonly renderedText: string;
	readonly vector: readonly number[];
}

export interface MemoryRecallSnapshot {
	readonly activation: MemoryActivationRecord;
	readonly embedding: MemoryEmbeddingConfiguration;
	readonly indexed: readonly IndexedMemoryCandidate[];
	readonly recent: readonly IndexedMemoryCandidate[];
}

const unjudged = { judged: false, relevance: null, relevanceScore: null, retained: false, requestIncluded: false, admission: "request-limit" } as const;

const sceneTextFor = (messages: readonly MemoryRecallSceneMessage[], pendingHumanText: string | undefined, humanName: string) => {
	const pendingAlreadySelected = pendingHumanText !== undefined && messages.at(-1)?.role === "human" && messages.at(-1)?.content === pendingHumanText;
	const scene = messages.slice(-(pendingHumanText !== undefined && !pendingAlreadySelected ? 3 : 4)).map((message) => ({
		messageId: message.messageId,
		text: `${message.speakerName ?? (message.role === "human" ? humanName : "Story")}: ${message.content}`,
	}));
	if (pendingHumanText !== undefined && !pendingAlreadySelected) {
		scene.push({ messageId: 0, text: `${humanName}: ${pendingHumanText}` });
	}
	let truncated = false;
	const render = () => scene.map((message) => message.text).join("\n\n");
	while (scene.length > 1 && tokenxEstimator(render()) > 4_000) {
		scene.shift();
		truncated = true;
	}
	if (scene.length === 1 && tokenxEstimator(render()) > 4_000) {
		const text = scene[0]!.text;
		let keep = 4_000;
		scene[0]!.text = sliceByTokens(text, -keep);
		while (keep > 0 && tokenxEstimator(render()) > 4_000) scene[0]!.text = sliceByTokens(text, -(keep -= tokenxEstimator(render()) - 4_000));
		truncated = true;
	}
	return {
		text: render(),
		messageIds: scene.filter((message) => message.messageId !== 0).map((message) => message.messageId),
		truncated,
	};
};

const scoreLabels = ["irrelevant", "incidental", "useful", "central"] as const;
const relevanceQuestion = (candidate: MemoryRecallCandidateRecord) => ({
	type: "score",
	instructions: { memory: { claim: candidate.claim, attribution: candidate.attribution }, question: "How much does `memory` help write the next reply to `scene`?" },
	criteria: [
		"Irrelevant: the next reply would be the same without it",
		"Incidental: loosely connected, such as background detail about someone present",
		"Useful: a fact, relationship, or earlier event the next reply should stay consistent with",
		"Central: the next reply depends on it, such as a promise, secret, or event being discussed",
	],
});

const parseScore = (answer: JevAnswer) => {
	if (answer.type !== "score" || !(answer.score >= 0 && answer.score <= scoreLabels.length - 1)) throw new Error("Typesafe returned a missing or malformed Memory relevance score.");
	if (scoreLabels.some((_, index) => !(answer.probabilities[String(index)]! >= 0 && answer.probabilities[String(index)]! <= 1))) throw new Error("Typesafe returned incomplete Memory relevance probabilities.");
	return { score: answer.score, label: scoreLabels[Math.round(answer.score)]! };
};

export async function judgeMemoryRecallCandidates(
	candidates: readonly MemoryRecallCandidateRecord[],
	scene: string,
	relevanceMinimum: number,
	credential: string,
	model = "jev-1.13.0",
	fetcher: ModelFetch = fetch,
	signal?: AbortSignal,
): Promise<MemoryRecallCandidateRecord[]> {
	if (candidates.length === 0) return [];
	if (!credential) throw new Error("Configure the Typesafe credential in Connections.");
	const buildRequest = (values: readonly MemoryRecallCandidateRecord[]) => {
		const questions = Object.fromEntries(values.map((candidate) => [`candidate_${candidate.identity}_relevance`, relevanceQuestion(candidate)]));
		return jevRequest(model, { scene }, questions);
	};
	let packed = [...candidates];
	let request = buildRequest(packed);
	while (packed.length > 0 && !request.fits) {
		packed.pop();
		request = buildRequest(packed);
	}
	if (packed.length === 0) throw new Error("Required Memory recall evidence exceeds the bounded Jev request.");
	const answers = await requestJev({ request: request.request, questionIds: request.questionIds, credential, fetch: fetcher, signal });
	const judged = new Map<string, MemoryRecallCandidateRecord>();
	for (const candidate of packed) {
		const relevance = parseScore(answers[`candidate_${candidate.identity}_relevance`]!);
		const retained = relevance.score >= relevanceMinimum;
		judged.set(candidate.identity, {
			...candidate,
			judged: true,
			relevance: relevance.label,
			relevanceScore: relevance.score,
			retained,
			requestIncluded: true,
			admission: retained ? "admitted" : "not-retained",
		});
	}
	return candidates.map((candidate) => judged.get(candidate.identity) ?? { ...candidate, ...unjudged });
}

const activationState = (input: { enabled: boolean; allowance: number; ready: number; unconfigured: boolean; pendingSourceCount: number; pendingIndexCount: number; failedIndexCount: number; failedSourceCount: number }): MemoryActivationRecord["state"] => {
	if (!input.enabled) return "disabled";
	if (input.allowance === 0) return "allowance-zero";
	const pending = input.pendingSourceCount > 0 || input.pendingIndexCount > 0;
	if (input.ready > 0) return pending || input.failedIndexCount > 0 || input.failedSourceCount > 0 ? "partial" : "ready";
	if (input.unconfigured) return "unconfigured";
	if (pending) return "rebuilding";
	if (input.failedIndexCount > 0) return "index-failed";
	return input.failedSourceCount > 0 ? "source-failed" : "empty";
};

export const captureMemoryRecallSnapshot = (input: {
	database: Database;
	conversationId: number;
	enabled: boolean;
	messages: readonly MemoryRecallSceneMessage[];
	pendingHumanText?: string;
	humanName: string;
}): MemoryRecallSnapshot => {
	const db = drizzle(input.database);
	const { allowance } = readMemoryAllowance(input.database, input.conversationId);
	const { recallRelevanceMinimum } = createMemorySettingsModule(input.database).get();
	const typesafe = createTypesafeSettingsModule(input.database).get();
	const embedding = readMemoryEmbeddingConfiguration(input.database);
	const scene = sceneTextFor(input.messages, input.pendingHumanText, input.humanName);
	const path = input.messages.map((message) => ({ messageId: message.messageId, variantId: message.variantId, contentHash: sha256(message.content) }));
	const variantIds = [...new Set(input.messages.map((message) => message.variantId))];
	const active = variantIds.length === 0 ? new Set<number>() : new Set(db.select({ id: activeGenerationTable.variant_id }).from(activeGenerationTable).where(inArray(activeGenerationTable.variant_id, variantIds)).all().map((row) => row.id));
	const collections = variantIds.length === 0 ? [] : db.select().from(memoryCollectionTable).where(and(eq(memoryCollectionTable.conversation_id, input.conversationId), inArray(memoryCollectionTable.variant_id, variantIds))).orderBy(asc(memoryCollectionTable.message_id)).all();
	const byVariant = new Map(collections.map((collection) => [collection.variant_id, collection]));
	const readinessByVariant = readMemoryIndexReadinessBatch(input.database, collections, input.enabled, embedding);
	const fingerprintSources: unknown[] = [];
	const claimed: Omit<IndexedMemoryCandidate, "vector">[] = [];
	const counts = { pendingSourceCount: 0, pendingIndexCount: 0, failedIndexCount: 0, failedSourceCount: 0 };
	let unconfigured = false;
	let eligibleSourceCount = 0;
	for (const message of input.messages) {
		if (active.has(message.variantId)) continue;
		eligibleSourceCount += 1;
		const collection = byVariant.get(message.variantId);
		if (!collection) {
			fingerprintSources.push({ messageId: message.messageId, variantId: message.variantId, status: "unprocessed" });
			continue;
		}
		const sourceChanged = collection.source_changed || sha256(message.content) !== collection.source_hash;
		const staleAutomaticSource = collection.ownership === "automatic" && sourceChanged;
		const readiness = readinessByVariant.get(collection.variant_id)!;
		if (collection.status === "pending" || collection.status === "running") counts.pendingSourceCount += 1;
		if (readiness.status === "unconfigured") unconfigured = true;
		counts.pendingIndexCount += readiness.pendingCount;
		counts.failedIndexCount += readiness.failedCount;
		if (collection.status === "failed" || staleAutomaticSource) counts.failedSourceCount += 1;
		fingerprintSources.push({ messageId: message.messageId, variantId: message.variantId, position: message.position, revision: collection.revision, ownership: collection.ownership, status: collection.status, sourceChanged, indexStatus: readiness.status, pendingIndexCount: readiness.pendingCount, failedIndexCount: readiness.failedCount });
		if (!input.enabled || staleAutomaticSource || collection.status !== "complete" || readiness.status === "disabled" || readiness.status === "unconfigured" || readiness.status === "not-applicable") continue;
		let claims: MemoryCandidateJudgment[];
		try { claims = Value.Parse(memoryCandidates, JSON.parse(collection.claims_json)); } catch { counts.failedSourceCount += 1; continue; }
		for (const [claimIndex, claim] of claims.entries()) claimed.push({
			record: {
				identity: `${message.messageId}:${message.variantId}:${collection.revision}:${claimIndex}`,
				messageId: message.messageId, variantId: message.variantId, collectionRevision: collection.revision,
				ownership: collection.ownership, sourceChanged, claimIndex, claim: claim.claim, attribution: claim.attribution,
				people: claim.people, evidence: claim.evidence, sourcePosition: message.position,
			},
			renderedText: renderMemoryClaim(claim),
		});
	}
	const vectors = readCachedMemoryVectors(input.database, embedding.spaceKey, claimed.map(({ renderedText }) => renderedText));
	const indexed = claimed.flatMap((candidate) => {
		const vector = vectors.get(candidate.renderedText);
		return vector ? [{ ...candidate, vector }] : [];
	});
	const activation: MemoryActivationRecord = {
		version: 1,
		state: activationState({ enabled: input.enabled, allowance, ready: indexed.length, unconfigured, ...counts }),
		allowance, eligibleSourceCount, readyRecordCount: indexed.length,
		embeddingModel: embedding.model, embeddingDeadlineMs: embedding.deadlineMs,
		jevModel: typesafe.jevModel, jevConfigured: typesafe.credentialConfigured, relevanceMinimum: recallRelevanceMinimum,
		...counts,
		sourceSnapshotFingerprint: sha256(JSON.stringify({ path, sources: fingerprintSources })),
		embeddingConfigurationFingerprint: sha256(JSON.stringify(embedding)),
		scanMessageIds: scene.messageIds, scanTruncated: scene.truncated, scene: scene.text,
		semanticShortlistCount: 0, recentShortlistCount: 0, candidates: [], automaticMemoryText: "", finalMemoryText: "", manuallyEdited: false,
	};
	const recent = [...indexed].sort((left, right) => right.record.sourcePosition - left.record.sourcePosition || left.record.identity.localeCompare(right.record.identity)).slice(0, 16);
	return { activation, embedding, indexed, recent };
};

export const evaluateMemoryRecallSnapshot = async (input: {
	database: Database;
	snapshot: MemoryRecallSnapshot;
	fetch?: ModelFetch;
	signal?: AbortSignal;
}): Promise<MemoryActivationRecord> => {
	const { activation, indexed, recent } = input.snapshot;
	if (activation.state === "disabled" || activation.allowance === 0 || indexed.length === 0) return activation;
	let semantic: { candidate: IndexedMemoryCandidate; similarity: number }[] = [];
	if (activation.scene.trim().length > 0) {
		const queryVector = (await embedMemoryQuery(input.database, activation.scene, input.snapshot.embedding, input.fetch))[0];
		if (!queryVector) throw new Error("The embedding endpoint returned no Memory query vector.");
		if (indexed.some((record) => record.vector.length !== queryVector.length)) throw new Error("A compatible Memory vector has different dimensions from the current query. Rebuild Memory indexes before retrying recall.");
		semantic = indexed.map((candidate) => ({ candidate, similarity: cosineSimilarity(queryVector, candidate.vector) }))
			.sort((left, right) => right.similarity - left.similarity || left.candidate.record.identity.localeCompare(right.candidate.record.identity))
			.slice(0, 48);
	}
	const shortlist = new Map<string, MemoryRecallCandidateRecord>();
	for (const [index, { candidate, similarity }] of semantic.entries()) shortlist.set(candidate.record.identity, { ...candidate.record, semanticSimilarity: similarity, semanticRank: index + 1, recentRank: null, ...unjudged });
	for (const [index, candidate] of recent.entries()) {
		const existing = shortlist.get(candidate.record.identity);
		shortlist.set(candidate.record.identity, existing ? { ...existing, recentRank: index + 1 } : { ...candidate.record, semanticSimilarity: null, semanticRank: null, recentRank: index + 1, ...unjudged });
	}
	const candidates = await judgeMemoryRecallCandidates([...shortlist.values()], activation.scene, activation.relevanceMinimum, createTypesafeSettingsModule(input.database).getCredential() ?? "", activation.jevModel, input.fetch, input.signal);
	return { ...activation, semanticShortlistCount: semantic.length, recentShortlistCount: recent.length, candidates };
};
