import { readActiveVariantIds } from "../conversation";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sliceByTokens } from "tokenx";
import type { MemoryActivationRecord, MemoryRecallCandidateRecord } from "../../shared/contract/memory-recall";
import { renderMemoryClaim } from "../../shared/memory-text";
import { applyMemoryPeople } from "../../shared/memory-identity";
import { createMemorySettingsModule } from "./settings";
import {
	decisionRequest,
	largestFittingBatch,
	type DecisionSelectionResolution,
	type ResolvedDecisionModel,
} from "../decision-model";
import { cosineSimilarity } from "../model-client/embeddings";
import { tokenxEstimator } from "../prompt-compiler";
import { projectImageAnchors } from "../../shared/image-reference";
import type { BoxContext } from "../box/contract";
import { readBoxDecisionSettings, resolveBoxDecision } from "../box/decision-settings";
import { effectiveRecord, hasAutomaticRecord, hasDigestError, readRecordSlots } from "../box/records";
import { readBoxInstances } from "../box/setup";
import { embedAndCacheMemoryTexts, readMemoryEmbeddingConfiguration, type MemoryEmbeddingConfiguration } from "./indexing";
import { readMemoryAllowance } from "./memories";
import { isExcludedAuthor, readMemoryLabelState } from "./labels";
import { sha256 } from "./hash";
import type { DecisionAnswer } from "../../shared/contract/decision-model";

/** @approved `content` is the Message as the model reads it, Moves included; `prose` is the Variant's stored text, which its Memory record was digested from. */
export interface MemoryRecallSceneMessage {
	readonly messageId: number;
	readonly variantId: number;
	readonly position: number;
	readonly authorId: number | null;
	readonly speakerName: string | null;
	readonly role: "human" | "model" | null;
	readonly content: string;
	readonly prose: string;
}

interface ClaimedMemory {
	readonly record: RecallCandidateBase;
	readonly renderedText: string;
}

export type MemoryRecallSnapshot = DecisionSelectionResolution & {
	readonly freshnessFingerprint: string;
	readonly activation: MemoryActivationRecord;
	readonly embedding: MemoryEmbeddingConfiguration;
	readonly claimed: readonly ClaimedMemory[];
	readonly recent: readonly ClaimedMemory[];
};

const unjudged = { relevance: null, relevanceScore: null, admission: "request-limit" } as const;

const SCENE_TOKEN_LIMIT = 4_000;

const fitToTokenBudget = (text: string, limit: number) => {
	for (let keep = limit; keep > 0;) {
		const fitted = sliceByTokens(text, -keep);
		const over = tokenxEstimator(fitted) - limit;
		if (over <= 0) return fitted;
		keep -= over;
	}
	return "";
};

const sceneTextFor = (messages: readonly MemoryRecallSceneMessage[], pendingHumanText: string | undefined, humanName: string, limit: number) => {
	const pendingAlreadySelected = pendingHumanText !== undefined && messages.at(-1)?.role === "human" && messages.at(-1)?.content === pendingHumanText;
	const scene = messages.slice(-(pendingHumanText !== undefined && !pendingAlreadySelected ? 3 : 4)).map((message) => ({
		messageId: message.messageId,
		text: `${message.speakerName ?? (message.role === "human" ? humanName : "Story")}: ${projectImageAnchors(message.content)}`,
	}));
	if (pendingHumanText !== undefined && !pendingAlreadySelected) {
		scene.push({ messageId: 0, text: `${humanName}: ${projectImageAnchors(pendingHumanText)}` });
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

const parseScore = (answer: DecisionAnswer | undefined) => {
	if (answer?.type !== "score" || !(answer.score >= 0 && answer.score <= scoreLabels.length - 1)) {
		throw new Error("Decision Model returned a missing or malformed Memory relevance score.");
	}
	if (scoreLabels.some((_, index) => !(answer.probabilities[String(index)]! >= 0 && answer.probabilities[String(index)]! <= 1))) {
		throw new Error("Decision Model returned incomplete Memory relevance probabilities.");
	}
	return { score: answer.score, label: scoreLabels[Math.round(answer.score)]! };
};

export async function judgeMemoryRecallCandidates({ candidates, scene, relevanceMinimum, selection, decide }: {
	candidates: readonly MemoryRecallCandidateRecord[];
	scene: string;
	relevanceMinimum: number;
	selection: ResolvedDecisionModel;
	decide: BoxContext<"decide">["decide"];
}): Promise<MemoryRecallCandidateRecord[]> {
	if (candidates.length === 0) return [];
	const batch = largestFittingBatch(candidates, (values) => {
		const questions = Object.fromEntries(values.map((candidate) => [`candidate_${candidate.identity}_relevance`, relevanceQuestion(candidate)]));
		return decisionRequest(selection, { scene }, questions);
	});
	if (batch === undefined) throw new Error("Required Memory recall evidence exceeds the bounded Decision Model request.");
	const answers = await decide({ request: batch.request, questions: batch.questions, selection });
	const judged = new Map<string, MemoryRecallCandidateRecord>();
	for (const candidate of batch.items) {
		const relevance = parseScore(answers.get(`candidate_${candidate.identity}_relevance`));
		judged.set(candidate.identity, { ...candidate, relevance: relevance.label, relevanceScore: relevance.score, admission: relevance.score >= relevanceMinimum ? "admitted" : "not-retained" });
	}
	return candidates.map((candidate) => judged.get(candidate.identity) ?? { ...candidate, ...unjudged });
}

const activationState = (input: {
	enabled: boolean;
	allowance: number;
	ready: number;
	unconfigured: boolean;
	pendingSourceCount: number;
	failedSourceCount: number;
}): MemoryActivationRecord["state"] => {
	if (!input.enabled) return "disabled";
	if (input.allowance === 0) return "allowance-zero";
	if (input.ready > 0) return input.pendingSourceCount > 0 || input.failedSourceCount > 0 ? "partial" : "ready";
	if (input.unconfigured) return "unconfigured";
	if (input.pendingSourceCount > 0) return "rebuilding";
	return input.failedSourceCount > 0 ? "source-failed" : "empty";
};

type RecallCandidateBase = Omit<MemoryRecallCandidateRecord, "semanticSimilarity" | "semanticRank" | "recentRank" | "relevance" | "relevanceScore" | "admission">;

type RecallSceneInput = {
	database: Database;
	conversationId: number;
	enabled: boolean;
	messages: readonly MemoryRecallSceneMessage[];
	pendingHumanText?: string;
	humanName: string;
};

// @approved
//  One pass over the selected path's Memory records. Each passage counts as
//  failed when its digest failed on its current text, and as pending when it
//  has neither that digest's record nor a Writer override; a stale record
//  stays recallable until its new digest lands, as every effective record
//  does. `writers` are the overrides, the only records whose change marks an
//  inspected plan stale: a digest landing in the background does not.
const scanMemorySources = (input: RecallSceneInput) => {
	const db = drizzle(input.database);
	const active = readActiveVariantIds(input.database, input.conversationId);
	const labels = readMemoryLabelState(input.database, input.conversationId);
	const messages = input.messages.filter((message) => !active.has(message.variantId) && !isExcludedAuthor(labels, message.authorId) && message.prose.trim() !== "");
	const slots = readRecordSlots(db, "memory", readBoxInstances(db, input.conversationId).memory, messages.map((message) => message.variantId));
	const sources: { readonly variantId: number; readonly record: string | null; readonly digested: boolean; readonly failed: boolean }[] = [];
	const writers: { readonly variantId: number; readonly record: string }[] = [];
	const claimed: ClaimedMemory[] = [];
	const counts = { pendingSourceCount: 0, failedSourceCount: 0 };
	for (const message of messages) {
		const slot = slots.get(message.variantId);
		const record = effectiveRecord(slot);
		const digested = hasAutomaticRecord(slot, message.prose);
		const failed = hasDigestError(slot, message.prose);
		const hash = record === undefined ? null : sha256(JSON.stringify(record));
		if (failed) counts.failedSourceCount += 1;
		else if (slot?.writer === undefined && !digested) counts.pendingSourceCount += 1;
		sources.push({ variantId: message.variantId, record: hash, digested, failed });
		if (slot?.writer !== undefined) writers.push({ variantId: message.variantId, record: sha256(JSON.stringify(slot.writer)) });
		if (!input.enabled || record === undefined || hash === null) continue;
		for (const [claimIndex, claim] of record.claims.entries()) claimed.push({
			record: {
				identity: `${message.messageId}:${message.variantId}:${claimIndex}:${hash.slice(0, 16)}`,
				messageId: message.messageId,
				variantId: message.variantId,
				writer: slot?.writer !== undefined,
				sourceChanged: slot?.source !== undefined && !digested,
				claimIndex,
				claim: claim.claim,
				attribution: claim.attribution,
				people: applyMemoryPeople(claim.people, labels.cast, labels.identities, labels.merges),
				evidence: claim.evidence,
				sourcePosition: message.position,
			},
			renderedText: renderMemoryClaim(claim),
		});
	}
	return { sources, writers, claimed, counts, labelRevision: labels.revision, eligibleSourceCount: messages.length };
};

export const captureMemoryRecallSnapshot = (input: RecallSceneInput): MemoryRecallSnapshot => {
	const { allowance, revision: allowanceRevision } = readMemoryAllowance(input.database, input.conversationId);
	const { recallRelevanceMinimum } = createMemorySettingsModule(input.database).get();
	const decision = readBoxDecisionSettings(input.database, "memory");
	const resolution = resolveBoxDecision(input.database, "memory");
	const embedding = readMemoryEmbeddingConfiguration(input.database);
	const scene = sceneTextFor(input.messages, input.pendingHumanText, input.humanName, Math.min(SCENE_TOKEN_LIMIT, decision.decisionStateTokenLimit));
	const path = input.messages.map((message) => ({ messageId: message.messageId, variantId: message.variantId, contentHash: sha256(message.content) }));
	const scan = scanMemorySources(input);
	const unconfigured = embedding.spaceKey === "" && scan.claimed.length > 0;
	const ready = unconfigured ? 0 : scan.claimed.length;
	const activation: MemoryActivationRecord = {
		version: 1,
		state: activationState({ enabled: input.enabled, allowance, ready, unconfigured, ...scan.counts }),
		allowance,
		eligibleSourceCount: scan.eligibleSourceCount,
		readyRecordCount: ready,
		embeddingModel: embedding.model,
		embeddingDeadlineMs: embedding.deadlineMs,
		decisionProfileName: resolution.kind === "ready" ? resolution.decision.profileName : null,
		decisionModel: decision.decisionModel,
		decisionConfigured: resolution.kind === "ready",
		relevanceMinimum: recallRelevanceMinimum,
		...scan.counts,
		sourceSnapshotFingerprint: sha256(JSON.stringify({ path, sources: scan.sources })),
		embeddingConfigurationFingerprint: sha256(JSON.stringify(embedding)),
		scanMessageIds: scene.messageIds,
		scanTruncated: scene.truncated,
		scene: scene.text,
		semanticShortlistCount: 0,
		recentShortlistCount: 0,
		candidates: [],
		automaticMemoryText: "",
		finalMemoryText: "",
		manuallyEdited: false,
	};
	const claimed = unconfigured ? [] : scan.claimed;
	const recent = [...claimed].sort((left, right) => right.record.sourcePosition - left.record.sourcePosition || left.record.identity.localeCompare(right.record.identity)).slice(0, 16);
	const freshnessFingerprint = sha256(JSON.stringify({
		enabled: input.enabled,
		recallRelevanceMinimum,
		decision: { profileId: decision.decisionProfileId, model: decision.decisionModel, stateTokenLimit: decision.decisionStateTokenLimit },
		allowanceRevision,
		labelRevision: scan.labelRevision,
		embedding,
		writers: scan.writers,
	}));
	return { freshnessFingerprint, activation, embedding, claimed, recent, ...resolution };
};

// @approved
//  Recall embeds any claim text the cache lacks, such as a Writer's edit,
//  before ranking every claim against the scene.
export const evaluateMemoryRecallSnapshot = async (input: {
	database: Database;
	snapshot: MemoryRecallSnapshot;
} & BoxContext<"decide" | "embed">): Promise<MemoryActivationRecord> => {
	const { activation, claimed, recent, embedding } = input.snapshot;
	if (activation.state === "disabled" || activation.allowance === 0 || claimed.length === 0) return activation;
	switch (input.snapshot.kind) {
		case "off": throw new Error("Choose a Memory Decision Model in Connection Settings.");
		case "unavailable": throw new Error(`${input.snapshot.reason} Check the Memory Decision Model in Connection Settings.`);
		case "ready": break;
	}
	const selection = input.snapshot.decision;
	let semantic: { candidate: ClaimedMemory; similarity: number }[] = [];
	if (activation.scene.trim().length > 0) {
		const vectors = await embedAndCacheMemoryTexts(input.database, claimed.map(({ renderedText }) => renderedText), embedding, input.embed);
		const queryVector = (await input.embed([activation.scene], embedding))[0];
		if (!queryVector) throw new Error("The embedding endpoint returned no Memory query vector.");
		if ([...vectors.values()].some((vector) => vector.length !== queryVector.length)) {
			throw new Error("The embedding endpoint answered with a different vector size than the Memories it embedded before. Choose another embedding model in Memory Settings.");
		}
		semantic = claimed.map((candidate) => ({ candidate, similarity: cosineSimilarity(queryVector, vectors.get(candidate.renderedText)!) }))
			.sort((left, right) => right.similarity - left.similarity || left.candidate.record.identity.localeCompare(right.candidate.record.identity))
			.slice(0, 48);
	}
	const shortlist = new Map<string, MemoryRecallCandidateRecord>();
	for (const [index, { candidate, similarity }] of semantic.entries()) {
		shortlist.set(candidate.record.identity, { ...candidate.record, semanticSimilarity: similarity, semanticRank: index + 1, recentRank: null, ...unjudged });
	}
	for (const [index, candidate] of recent.entries()) {
		const existing = shortlist.get(candidate.record.identity);
		shortlist.set(candidate.record.identity, existing
			? { ...existing, recentRank: index + 1 }
			: { ...candidate.record, semanticSimilarity: null, semanticRank: null, recentRank: index + 1, ...unjudged });
	}
	input.signal.throwIfAborted();
	const candidates = await judgeMemoryRecallCandidates({
		candidates: [...shortlist.values()],
		scene: activation.scene,
		relevanceMinimum: activation.relevanceMinimum,
		selection,
		decide: input.decide,
	});
	return { ...activation, semanticShortlistCount: semantic.length, recentShortlistCount: recent.length, candidates };
};
