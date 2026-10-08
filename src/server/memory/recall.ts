import type { MemorySettingsPayload } from "../../shared/contract/memory-settings";
import { readActiveVariantIds } from "../conversation";
import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import { sliceByTokens } from "tokenx";
import { memoryCandidates } from "../../shared/contract/memory";
import type { MemoryActivationRecord, MemoryRecallCandidateRecord } from "../../shared/contract/memory-recall";
import { renderMemoryClaim } from "../../shared/memory-text";
import { memoryCollectionTable } from "../database/schema";
import { createMemorySettingsModule } from "./settings";
import {
	decisionRequest,
	largestFittingBatch,
	requestDecisions,
	tryResolveDecisionSelection,
	type DecisionSelectionResolution,
	type ResolvedDecisionModel,
} from "../decision-model";
import { cosineSimilarity } from "../model-client/embeddings";
import { tokenxEstimator } from "../prompt-compiler";
import { projectImageAnchors } from "../../shared/image-reference";
import type { ModelFetch } from "../model-client/types";
import {
	embedMemoryQuery,
	readCachedMemoryVectors,
	readMemoryEmbeddingConfiguration,
	readMemoryIndexReadinessBatch,
	type MemoryEmbeddingConfiguration,
} from "./indexing";
import { readMemoryAllowance } from "./collections";
import { readMemoryLabelState } from "./labels";
import { sha256 } from "./hash";
import type { MemoryCandidateJudgment, MemoryIndexReadiness } from "../../shared/contract/memory";
import type { DecisionAnswer } from "../../shared/contract/decision-model";

export interface MemoryRecallSceneMessage {
	readonly messageId: number;
	readonly variantId: number;
	readonly position: number;
	readonly speakerName: string | null;
	readonly role: "human" | "model" | null;
	readonly content: string;
}

interface IndexedMemoryCandidate {
	readonly record: RecallCandidateBase;
	readonly renderedText: string;
	readonly vector: readonly number[];
}

export type MemoryRecallSnapshot = DecisionSelectionResolution & {
	readonly freshnessFingerprint: string;
	readonly activation: MemoryActivationRecord;
	readonly embedding: MemoryEmbeddingConfiguration;
	readonly indexed: readonly IndexedMemoryCandidate[];
	readonly recent: readonly IndexedMemoryCandidate[];
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

export async function judgeMemoryRecallCandidates({ candidates, scene, relevanceMinimum, selection, fetch, signal }: {
	candidates: readonly MemoryRecallCandidateRecord[];
	scene: string;
	relevanceMinimum: number;
	selection: ResolvedDecisionModel;
	fetch?: ModelFetch;
	signal?: AbortSignal;
}): Promise<MemoryRecallCandidateRecord[]> {
	if (candidates.length === 0) return [];
	const batch = largestFittingBatch(candidates, (values) => {
		const questions = Object.fromEntries(values.map((candidate) => [`candidate_${candidate.identity}_relevance`, relevanceQuestion(candidate)]));
		return decisionRequest(selection, { scene }, questions);
	});
	if (batch === undefined) throw new Error("Required Memory recall evidence exceeds the bounded Decision Model request.");
	const answers = await requestDecisions({ request: batch.request, questions: batch.questions, selection, fetch, signal });
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
	pendingIndexCount: number;
	failedIndexCount: number;
	failedSourceCount: number;
}): MemoryActivationRecord["state"] => {
	if (!input.enabled) return "disabled";
	if (input.allowance === 0) return "allowance-zero";
	const pending = input.pendingSourceCount > 0 || input.pendingIndexCount > 0;
	if (input.ready > 0) return pending || input.failedIndexCount > 0 || input.failedSourceCount > 0 ? "partial" : "ready";
	if (input.unconfigured) return "unconfigured";
	if (pending) return "rebuilding";
	if (input.failedIndexCount > 0) return "index-failed";
	return input.failedSourceCount > 0 ? "source-failed" : "empty";
};

type CollectionRow = typeof memoryCollectionTable.$inferSelect;

type RecallCandidateBase = Omit<MemoryRecallCandidateRecord, "semanticSimilarity" | "semanticRank" | "recentRank" | "relevance" | "relevanceScore" | "admission">;

interface ReadRecallInputs {
	readonly collections: CollectionRow[];
	readonly activeVariants: ReadonlySet<number>;
	readonly byVariant: ReadonlyMap<number, CollectionRow>;
	readonly readinessByVariant: ReadonlyMap<number, MemoryIndexReadiness>;
	readonly scene: ReturnType<typeof sceneTextFor>;
	readonly path: readonly { readonly messageId: number; readonly variantId: number; readonly contentHash: string }[];
	readonly allowance: number;
	readonly allowanceRevision: number;
	readonly recallRelevanceMinimum: number;
	readonly memorySettings: MemorySettingsPayload;
	readonly embedding: MemoryEmbeddingConfiguration;
	readonly resolution: DecisionSelectionResolution;
}

type UnprocessedRecallSource = { readonly messageId: number; readonly variantId: number; readonly status: "unprocessed" };

type ScannedRecallSource = {
	readonly messageId: number;
	readonly variantId: number;
	readonly position: number;
	readonly revision: number;
	readonly ownership: CollectionRow["ownership"];
	readonly status: CollectionRow["status"];
	readonly sourceChanged: boolean;
	readonly indexStatus: MemoryIndexReadiness["status"];
	readonly pendingIndexCount: number;
	readonly failedIndexCount: number;
};

interface RecallSourceScan {
	readonly fingerprintSources: readonly (UnprocessedRecallSource | ScannedRecallSource)[];
	readonly claimed: readonly { readonly record: RecallCandidateBase; readonly renderedText: string }[];
	readonly counts: { readonly pendingSourceCount: number; readonly pendingIndexCount: number; readonly failedIndexCount: number; readonly failedSourceCount: number };
	readonly unconfigured: boolean;
	readonly eligibleSourceCount: number;
}

type RecallSceneInput = {
	database: Database;
	conversationId: number;
	enabled: boolean;
	messages: readonly MemoryRecallSceneMessage[];
	pendingHumanText?: string;
	humanName: string;
};

const readRecallInputs = (input: RecallSceneInput): ReadRecallInputs => {
	const db = drizzle(input.database);
	const { allowance, revision: allowanceRevision } = readMemoryAllowance(input.database, input.conversationId);
	const memorySettings = createMemorySettingsModule(input.database).get();
	const recallRelevanceMinimum = memorySettings.recallRelevanceMinimum;
	const resolution = tryResolveDecisionSelection(input.database, memorySettings);
	const embedding = readMemoryEmbeddingConfiguration(input.database);
	const limit = Math.min(SCENE_TOKEN_LIMIT, memorySettings.decisionStateTokenLimit);
	const scene = sceneTextFor(input.messages, input.pendingHumanText, input.humanName, limit);
	const path = input.messages.map((message) => ({ messageId: message.messageId, variantId: message.variantId, contentHash: sha256(message.content) }));
	const variantIds = [...new Set(input.messages.map((message) => message.variantId))];
	const activeVariants = readActiveVariantIds(input.database, input.conversationId);
	const collections = variantIds.length === 0
		? []
		: db.select().from(memoryCollectionTable)
			.where(and(eq(memoryCollectionTable.conversation_id, input.conversationId), inArray(memoryCollectionTable.variant_id, variantIds)))
			.orderBy(asc(memoryCollectionTable.message_id))
			.all();
	const byVariant = new Map(collections.map((collection) => [collection.variant_id, collection]));
	const readinessByVariant = readMemoryIndexReadinessBatch(input.database, collections, input.enabled, embedding);
	return { collections, activeVariants, byVariant, readinessByVariant, scene, path, allowance, allowanceRevision, recallRelevanceMinimum, memorySettings, embedding, resolution };
};

const scanMemorySources = (input: RecallSceneInput, inputs: ReadRecallInputs): RecallSourceScan => {
	const fingerprintSources: (UnprocessedRecallSource | ScannedRecallSource)[] = [];
	const claimed: { record: RecallCandidateBase; renderedText: string }[] = [];
	const counts = { pendingSourceCount: 0, pendingIndexCount: 0, failedIndexCount: 0, failedSourceCount: 0 };
	let unconfigured = false;
	let eligibleSourceCount = 0;
	for (const message of input.messages) {
		if (inputs.activeVariants.has(message.variantId)) continue;
		eligibleSourceCount += 1;
		const collection = inputs.byVariant.get(message.variantId);
		if (!collection) {
			fingerprintSources.push({ messageId: message.messageId, variantId: message.variantId, status: "unprocessed" });
			continue;
		}
		const sourceChanged = collection.source_changed || sha256(message.content) !== collection.source_hash;
		const staleAutomaticSource = collection.ownership === "automatic" && sourceChanged;
		const readiness = inputs.readinessByVariant.get(collection.variant_id)!;
		if (collection.status === "pending" || collection.status === "running") counts.pendingSourceCount += 1;
		if (readiness.status === "unconfigured") unconfigured = true;
		counts.pendingIndexCount += readiness.pendingCount;
		counts.failedIndexCount += readiness.status === "failed" ? 1 : 0;
		if (collection.status === "failed" || staleAutomaticSource) counts.failedSourceCount += 1;
		fingerprintSources.push({
			messageId: message.messageId,
			variantId: message.variantId,
			position: message.position,
			revision: collection.revision,
			ownership: collection.ownership,
			status: collection.status,
			sourceChanged,
			indexStatus: readiness.status,
			pendingIndexCount: readiness.pendingCount,
			failedIndexCount: readiness.status === "failed" ? 1 : 0,
		});
		if (!input.enabled || staleAutomaticSource || collection.status !== "complete") continue;
		if (readiness.status === "disabled" || readiness.status === "unconfigured" || readiness.status === "not-applicable") continue;
		let claims: MemoryCandidateJudgment[];
		try { claims = Value.Parse(memoryCandidates, JSON.parse(collection.claims_json)); } catch { counts.failedSourceCount += 1; continue; }
		for (const [claimIndex, claim] of claims.entries()) claimed.push({
			record: {
				identity: `${message.messageId}:${message.variantId}:${collection.revision}:${claimIndex}`,
				messageId: message.messageId,
				variantId: message.variantId,
				collectionRevision: collection.revision,
				ownership: collection.ownership,
				sourceChanged,
				claimIndex,
				claim: claim.claim,
				attribution: claim.attribution,
				people: claim.people,
				evidence: claim.evidence,
				sourcePosition: message.position,
			},
			renderedText: renderMemoryClaim(claim),
		});
	}
	return { fingerprintSources, claimed, counts, unconfigured, eligibleSourceCount };
};

interface RecallAssembly {
	readonly activation: MemoryActivationRecord;
	readonly indexed: readonly IndexedMemoryCandidate[];
}

const assembleRecallActivation = (
	input: RecallSceneInput,
	inputs: ReadRecallInputs,
	scan: RecallSourceScan,
): RecallAssembly => {
	const vectors = readCachedMemoryVectors(input.database, inputs.embedding.spaceKey, scan.claimed.map(({ renderedText }) => renderedText));
	const indexed = scan.claimed.flatMap((candidate) => {
		const vector = vectors.get(candidate.renderedText);
		return vector ? [{ ...candidate, vector }] : [];
	});
	const activation: MemoryActivationRecord = {
		version: 1,
		state: activationState({ enabled: input.enabled, allowance: inputs.allowance, ready: indexed.length, unconfigured: scan.unconfigured, ...scan.counts }),
		allowance: inputs.allowance,
		eligibleSourceCount: scan.eligibleSourceCount,
		readyRecordCount: indexed.length,
		embeddingModel: inputs.embedding.model,
		embeddingDeadlineMs: inputs.embedding.deadlineMs,
		decisionProfileName: inputs.resolution.kind === "ready" ? inputs.resolution.decision.profileName : null,
		decisionModel: inputs.memorySettings.decisionModel,
		decisionConfigured: inputs.resolution.kind === "ready",
		relevanceMinimum: inputs.recallRelevanceMinimum,
		...scan.counts,
		sourceSnapshotFingerprint: sha256(JSON.stringify({ path: inputs.path, sources: scan.fingerprintSources })),
		embeddingConfigurationFingerprint: sha256(JSON.stringify(inputs.embedding)),
		scanMessageIds: inputs.scene.messageIds,
		scanTruncated: inputs.scene.truncated,
		scene: inputs.scene.text,
		semanticShortlistCount: 0,
		recentShortlistCount: 0,
		candidates: [],
		automaticMemoryText: "",
		finalMemoryText: "",
		manuallyEdited: false,
	};
	return { activation, indexed };
};

const readRecallFreshness = (input: RecallSceneInput, inputs: ReadRecallInputs): string => sha256(JSON.stringify({
	enabled: input.enabled,
	recallRelevanceMinimum: inputs.recallRelevanceMinimum,
	decisionSelection: { profileId: inputs.memorySettings.decisionProfileId, model: inputs.memorySettings.decisionModel, stateTokenLimit: inputs.memorySettings.decisionStateTokenLimit },
	allowanceRevision: inputs.allowanceRevision,
	labelRevision: readMemoryLabelState(input.database, input.conversationId).revision,
	embedding: inputs.embedding,
	collections: inputs.collections.map((collection) => ({ variantId: collection.variant_id, revision: collection.revision })),
}));

export const captureMemoryRecallSnapshot = (input: {
	database: Database;
	conversationId: number;
	enabled: boolean;
	messages: readonly MemoryRecallSceneMessage[];
	pendingHumanText?: string;
	humanName: string;
}): MemoryRecallSnapshot => {
	const inputs = readRecallInputs(input);
	const scan = scanMemorySources(input, inputs);
	const { activation, indexed } = assembleRecallActivation(input, inputs, scan);
	const recent = [...indexed].sort((left, right) => right.record.sourcePosition - left.record.sourcePosition || left.record.identity.localeCompare(right.record.identity)).slice(0, 16);
	const freshnessFingerprint = readRecallFreshness(input, inputs);
	return { freshnessFingerprint, activation, embedding: inputs.embedding, indexed, recent, ...inputs.resolution };
};

export const evaluateMemoryRecallSnapshot = async (input: {
	database: Database;
	snapshot: MemoryRecallSnapshot;
	fetch?: ModelFetch;
	signal?: AbortSignal;
}): Promise<MemoryActivationRecord> => {
	const { activation, indexed, recent } = input.snapshot;
	if (activation.state === "disabled" || activation.allowance === 0 || indexed.length === 0) return activation;
	switch (input.snapshot.kind) {
		case "off": throw new Error("Choose a Decision Model in Memory Settings.");
		case "unavailable": throw new Error(`${input.snapshot.reason} Check Memory Settings.`);
		case "ready": break;
	}
	const selection = input.snapshot.decision;
	let semantic: { candidate: IndexedMemoryCandidate; similarity: number }[] = [];
	if (activation.scene.trim().length > 0) {
		const queryVector = (await embedMemoryQuery(input.database, activation.scene, input.snapshot.embedding, input.fetch, input.signal))[0];
		if (!queryVector) throw new Error("The embedding endpoint returned no Memory query vector.");
		if (indexed.some((record) => record.vector.length !== queryVector.length)) {
			throw new Error("A compatible Memory vector has different dimensions from the current query. Rebuild Memory indexes before retrying recall.");
		}
		semantic = indexed.map((candidate) => ({ candidate, similarity: cosineSimilarity(queryVector, candidate.vector) }))
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
	input.signal?.throwIfAborted();
	const candidates = await judgeMemoryRecallCandidates({
		candidates: [...shortlist.values()],
		scene: activation.scene,
		relevanceMinimum: activation.relevanceMinimum,
		selection,
		fetch: input.fetch,
		signal: input.signal,
	});
	return { ...activation, semanticShortlistCount: semantic.length, recentShortlistCount: recent.length, candidates };
};
