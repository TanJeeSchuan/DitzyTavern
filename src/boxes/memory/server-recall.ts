import { sliceByTokens } from "tokenx";
import {
	cosineSimilarity, effectiveRecord, hasAutomaticRecord, hasDigestError, largestFittingBatch, decisionRequest, readActiveVariantIds, readBoxDecision,
	sha256, tokenxEstimator,
	type BoxContext, type CaptureRead, type DecisionAnswer, type EmbeddingConfiguration,
} from "@/box-sdk/server";
import { projectImageAnchors } from "@/box-sdk/shared";
import type { MemoryActivationRecord, MemoryRecallCandidateRecord, MemoryRecord } from "./contract";
import { renderMemoryClaim } from "./shared";
import { isExcludedAuthor, readMemoryChatSettings, readMemoryLabelState } from "./server-chat";
import { memoryRecordFingerprint } from "./server-sources";
import { createMemorySettingsModule, readMemoryEmbedding } from "./server-settings";

export type RecallCandidate = MemoryRecallCandidateRecord & { claim: string; attribution: string };
export type RecallActivation = Omit<MemoryActivationRecord, "candidates"> & { candidates: RecallCandidate[] };

interface ClaimedMemory {
	readonly record: RecallCandidateBase;
	readonly renderedText: string;
}

export type MemoryRecallSnapshot = {
	readonly freshnessFingerprint: string;
	readonly activation: MemoryActivationRecord;
	readonly decision: ReturnType<typeof readBoxDecision>["status"];
	readonly selection: { readonly model: string; readonly stateTokenLimit: number };
	readonly embedding: EmbeddingConfiguration | undefined;
	readonly claimed: readonly ClaimedMemory[];
	readonly recent: readonly ClaimedMemory[];
};

const unjudged = { relevance: null, relevanceScore: null, admission: "request-limit" } as const;

const SCENE_TOKEN_LIMIT = 4_000;
const NEAR_DUPLICATE_SIMILARITY = 0.95;

const fitToTokenBudget = (text: string, limit: number) => {
	for (let keep = limit; keep > 0;) {
		const fitted = sliceByTokens(text, -keep);
		const over = tokenxEstimator(fitted) - limit;
		if (over <= 0) return fitted;
		keep -= over;
	}
	return "";
};

const sceneTextFor = (read: CaptureRead<MemoryRecord>, limit: number) => {
	const { messages, pending, human } = read;
	const pendingAlreadySelected = pending !== undefined && messages.at(-1)?.role === "human" && messages.at(-1)?.content === pending;
	const scene = messages.slice(-(pending !== undefined && !pendingAlreadySelected ? 3 : 4)).map((message) => ({
		messageId: message.messageId,
		text: `${message.speaker ?? (message.role === "human" ? human.name : "Story")}: ${projectImageAnchors(message.content)}`,
	}));
	if (pending !== undefined && !pendingAlreadySelected) {
		scene.push({ messageId: 0, text: `${human.name}: ${projectImageAnchors(pending)}` });
	}
	let truncated = false;
	const render = () => scene.map((message) => message.text).join("\n\n");
	while (scene.length > 1 && tokenxEstimator(JSON.stringify({ scene: render() })) > limit) {
		scene.shift();
		truncated = true;
	}
	const [only] = scene;
	if (only && scene.length === 1 && tokenxEstimator(JSON.stringify({ scene: only.text })) > limit) {
		for (let keep = limit; keep > 0; keep--) {
			only.text = fitToTokenBudget(only.text, keep);
			if (tokenxEstimator(JSON.stringify({ scene: only.text })) <= limit) break;
		}
		truncated = true;
	}
	return {
		text: render(),
		messageIds: scene.filter((message) => message.messageId !== 0).map((message) => message.messageId),
		truncated,
	};
};

const scoreLabels = ["irrelevant", "incidental", "useful", "central"] as const;
const relevanceQuestion = (candidate: RecallCandidate) => ({
	type: "score",
	instructions: { memory: { claim: candidate.claim, attribution: candidate.attribution }, question: "How much does `memory` help write the next reply to `scene`?" },
	criteria: [
		"Irrelevant: the next reply would be the same without it",
		"Incidental: loosely connected, such as background detail about someone present",
		"Useful: a fact, relationship, or earlier event the next reply should stay consistent with",
		"Central: the next reply depends on it, such as a promise, secret, or event being discussed",
	],
});

const parseScore = (answer: DecisionAnswer | undefined) => {
	if (answer?.type !== "score" || !(answer.score >= 0 && answer.score <= scoreLabels.length - 1)) {
		throw new Error("Decision Model returned a missing or malformed Memory relevance score.");
	}
	if (scoreLabels.some((_, index) => {
		const probability = answer.probabilities[String(index)];
		return probability === undefined || !(probability >= 0 && probability <= 1);
	})) {
		throw new Error("Decision Model returned incomplete Memory relevance probabilities.");
	}
	/** @approved The score was checked within the labels' range above, so its rounding names a label. */
	return { score: answer.score, label: scoreLabels[Math.round(answer.score)]! };
};

// @approved
//  Judges as many shortlisted candidates as fit one Decision Model request,
//  in shortlist order; the rest stay unjudged.
export async function judgeMemoryRecallCandidates({ candidates, scene, relevanceMinimum, selection, decide }: {
	candidates: readonly RecallCandidate[];
	scene: string;
	relevanceMinimum: number;
	selection: MemoryRecallSnapshot["selection"];
	decide: BoxContext["decide"];
}): Promise<RecallCandidate[]> {
	if (candidates.length === 0) return [];
	const batch = largestFittingBatch(candidates, (values) => {
		const questions = Object.fromEntries(values.map((candidate) => [`candidate_${candidate.identity}_relevance`, relevanceQuestion(candidate)]));
		return decisionRequest(selection, { scene }, questions);
	});
	if (batch === undefined) throw new Error("Required Memory recall evidence exceeds the bounded Decision Model request.");
	const answers = await decide({ scene }, batch.questions);
	const judged = new Map<string, RecallCandidate>();
	for (const candidate of batch.items) {
		const relevance = parseScore(answers.get(`candidate_${candidate.identity}_relevance`));
		judged.set(candidate.identity, { ...candidate, relevance: relevance.label, relevanceScore: relevance.score, admission: relevance.score >= relevanceMinimum ? "admitted" : "not-retained" });
	}
	return candidates.map((candidate) => judged.get(candidate.identity) ?? { ...candidate, ...unjudged });
}

const activationState = (input: {
	allowance: number;
	ready: number;
	unconfigured: boolean;
	pendingSourceCount: number;
	failedSourceCount: number;
}): MemoryActivationRecord["state"] => {
	if (input.allowance === 0) return "allowance-zero";
	if (input.ready > 0) return input.pendingSourceCount > 0 || input.failedSourceCount > 0 ? "partial" : "ready";
	if (input.unconfigured) return "unconfigured";
	if (input.pendingSourceCount > 0) return "rebuilding";
	return input.failedSourceCount > 0 ? "source-failed" : "empty";
};

type RecallCandidateBase = Omit<RecallCandidate, "semanticSimilarity" | "semanticRank" | "recentRank" | "relevance" | "relevanceScore" | "admission">;

// @approved
//  One pass over the selected path's Memory records. Each passage counts as
//  failed when its digest failed on its current text, and as pending when it
//  has neither that digest's record nor a Writer override; a stale record
//  stays recallable until its new digest lands, as every effective record
//  does. `writers` are the overrides, the only records whose change marks an
//  inspected plan stale: a digest landing in the background does not.
const scanMemorySources = (read: CaptureRead<MemoryRecord>) => {
	const active = readActiveVariantIds(read.database, read.conversationId);
	const labels = readMemoryLabelState(read.database, read.conversationId);
	const messages = read.messages.filter((message) => !active.has(message.variantId) && !isExcludedAuthor(labels, message.authorId) && message.prose.trim() !== "");
	const sources: { readonly variantId: number; readonly record: string | null; readonly digested: boolean; readonly failed: boolean }[] = [];
	const writers: { readonly variantId: number; readonly record: string }[] = [];
	const claimed: ClaimedMemory[] = [];
	const counts = { pendingSourceCount: 0, failedSourceCount: 0 };
	for (const message of messages) {
		const { slot } = message;
		const record = effectiveRecord(slot);
		const digested = hasAutomaticRecord(slot, message.prose);
		const failed = hasDigestError(slot, message.prose);
		const hash = record === undefined ? null : memoryRecordFingerprint(record);
		if (failed) counts.failedSourceCount += 1;
		else if (slot?.writer === undefined && !digested) counts.pendingSourceCount += 1;
		sources.push({ variantId: message.variantId, record: hash, digested, failed });
		if (slot?.writer !== undefined) writers.push({ variantId: message.variantId, record: sha256(JSON.stringify(slot.writer)) });
		if (record === undefined || hash === null) continue;
		for (const [claimIndex, claim] of record.claims.entries()) claimed.push({
			record: {
				identity: `${message.messageId}:${message.variantId}:${claimIndex}:${hash}`,
				messageId: message.messageId,
				variantId: message.variantId,
				writer: slot?.writer !== undefined,
				sourceChanged: slot?.source !== undefined && !digested,
				claimIndex,
				claim: claim.claim,
				attribution: claim.attribution,
				sourcePosition: message.position,
			},
			renderedText: renderMemoryClaim(claim),
		});
	}
	return { sources, writers, claimed, counts, labelRevision: labels.revision, eligibleSourceCount: messages.length };
};

export const captureMemoryRecallSnapshot = (read: CaptureRead<MemoryRecord>): MemoryRecallSnapshot => {
	const { allowance, revision: allowanceRevision } = readMemoryChatSettings(read.database, read.conversationId);
	const { recallRelevanceMinimum } = createMemorySettingsModule(read.database).get();
	const { status, ...decision } = readBoxDecision(read.database, "memory");
	const embedding = readMemoryEmbedding(read.database);
	const scene = sceneTextFor(read, Math.min(SCENE_TOKEN_LIMIT, decision.decisionStateTokenLimit));
	const path = read.messages.map((message) => ({ messageId: message.messageId, variantId: message.variantId, contentHash: sha256(message.content) }));
	const scan = scanMemorySources(read);
	const unconfigured = embedding === undefined && scan.claimed.length > 0;
	const ready = unconfigured ? 0 : scan.claimed.length;
	const activation: MemoryActivationRecord = {
		state: activationState({ allowance, ready, unconfigured, ...scan.counts }),
		allowance,
		eligibleSourceCount: scan.eligibleSourceCount,
		readyRecordCount: ready,
		embeddingModel: embedding?.model ?? "",
		embeddingDeadlineMs: embedding?.deadlineMs ?? 0,
		decisionProfileName: status.kind === "ready" ? status.profileName : null,
		decisionModel: decision.decisionModel,
		decisionConfigured: status.kind === "ready",
		relevanceMinimum: recallRelevanceMinimum,
		...scan.counts,
		sourceSnapshotFingerprint: sha256(JSON.stringify({ path, sources: scan.sources })),
		embeddingConfigurationFingerprint: sha256(JSON.stringify(embedding ?? null)),
		scanMessageIds: scene.messageIds,
		scanTruncated: scene.truncated,
		scene: scene.text,
		semanticShortlistCount: 0,
		recentShortlistCount: 0,
		candidates: [],
	};
	const claimed = unconfigured ? [] : scan.claimed;
	const recent = [...claimed].sort((left, right) => right.record.sourcePosition - left.record.sourcePosition || left.record.identity.localeCompare(right.record.identity)).slice(0, 16);
	const freshnessFingerprint = sha256(JSON.stringify({
		recallRelevanceMinimum,
		allowanceRevision,
		labelRevision: scan.labelRevision,
		embedding: embedding ?? null,
		writers: scan.writers,
	}));
	return {
		freshnessFingerprint, activation, embedding, claimed, recent,
		decision: status, selection: { model: decision.decisionModel, stateTokenLimit: decision.decisionStateTokenLimit },
	};
};

// @approved
//  Recall embeds any claim text the cache lacks, such as a Writer's edit,
//  before ranking every claim against the scene.
export const evaluateMemoryRecallSnapshot = async (snapshot: MemoryRecallSnapshot, ctx: BoxContext): Promise<RecallActivation> => {
	const { activation, claimed, recent, embedding } = snapshot;
	if (activation.allowance === 0 || claimed.length === 0 || embedding === undefined) return { ...activation, candidates: [] };
	switch (snapshot.decision.kind) {
		case "off": throw new Error("Choose a Memory Decision Model in Connection Settings.");
		case "unavailable": throw new Error(`${snapshot.decision.reason} Check the Memory Decision Model in Connection Settings.`);
		case "ready": break;
		default: {
			const _exhaustive: never = snapshot.decision;
			throw new Error(`Unhandled Memory Decision state: ${JSON.stringify(_exhaustive)}`);
		}
	}
	let semantic: { candidate: ClaimedMemory; similarity: number }[] = [];
	if (activation.scene.trim().length > 0) {
		// @approved The scene and claim embeddings run together; when one fails, the other is cancelled.
		const sibling = new AbortController();
		const together = async <T>(work: Promise<T>) => {
			try { return await work; } catch (error) { sibling.abort(); throw error; }
		};
		const [[queryVector], vectors] = await Promise.all([
			together(ctx.embed([activation.scene], embedding, { signal: sibling.signal })),
			together(ctx.embed(claimed.map(({ renderedText }) => renderedText), embedding, { cache: true, signal: sibling.signal })),
		]);
		if (!queryVector) throw new Error("The embedding endpoint returned no Memory query vector.");
		if (vectors.some((vector) => vector.length !== queryVector.length)) {
			throw new Error("The embedding endpoint answered with a different vector size than the Memories it embedded before. Choose another embedding model in Memory Settings.");
		}
		/** @approved `embed` returns one vector per text, in order. */
		const ranked = claimed.map((candidate, index) => ({ candidate, vector: vectors[index]!, similarity: cosineSimilarity(queryVector, vectors[index]!) }))
			.sort((left, right) => right.similarity - left.similarity || left.candidate.record.identity.localeCompare(right.candidate.record.identity));
		// One fact remembered from several scenes takes one slot, held by its latest telling.
		let kept: typeof ranked = [];
		for (const entry of ranked) {
			const twins = kept.filter(({ vector }) => cosineSimilarity(vector, entry.vector) >= NEAR_DUPLICATE_SIMILARITY);
			if (twins.some(({ candidate }) => candidate.record.sourcePosition >= entry.candidate.record.sourcePosition)) continue;
			const [first, ...rest] = twins;
			if (first === undefined) { if (kept.length < 48) kept.push(entry); }
			else kept = kept.filter((held) => !rest.includes(held)).map((held) => held === first ? entry : held);
		}
		semantic = kept;
	}
	const shortlist = new Map<string, RecallCandidate>();
	for (const [index, { candidate, similarity }] of semantic.entries()) {
		shortlist.set(candidate.record.identity, { ...candidate.record, semanticSimilarity: similarity, semanticRank: index + 1, recentRank: null, ...unjudged });
	}
	for (const [index, candidate] of recent.entries()) {
		const existing = shortlist.get(candidate.record.identity);
		shortlist.set(candidate.record.identity, existing
			? { ...existing, recentRank: index + 1 }
			: { ...candidate.record, semanticSimilarity: null, semanticRank: null, recentRank: index + 1, ...unjudged });
	}
	ctx.signal.throwIfAborted();
	const candidates = await judgeMemoryRecallCandidates({
		candidates: [...shortlist.values()],
		scene: activation.scene,
		relevanceMinimum: activation.relevanceMinimum,
		selection: snapshot.selection,
		decide: ctx.decide,
	});
	return { ...activation, semanticShortlistCount: semantic.length, recentShortlistCount: recent.length, candidates };
};
