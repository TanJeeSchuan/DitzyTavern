import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import { memoryCandidates } from "../../shared/contract/memory";
import type { MemoryActivationRecord, MemoryRecallCandidateRecord } from "../../shared/contract/memory-recall";
import { renderMemoryClaim } from "../../shared/memory-text";
import { activeGenerationTable, memoryCollectionTable } from "../database/schema";
import { createMemorySettingsModule } from "./settings";
import { createTypesafeSettingsModule } from "../typesafe";
import { cosineSimilarity, requestEmbeddings } from "../model-client/embeddings";
import { tokenxEstimator } from "../prompt-compiler";
import type { ModelFetch } from "../model-client/types";
import { readCachedMemoryVector, readMemoryEmbeddingConfiguration, readMemoryEmbeddingSecrets, readMemoryIndexReadiness } from "./indexing";
import { judgeMemoryRecallCandidates } from "./extraction";
import { memoryOwnership, readMemoryAllowance } from "./collections";
import { sha256 } from "./hash";
import type { MemoryCandidateJudgment } from "../../shared/contract/memory";

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
	readonly enabled: boolean;
	readonly allowance: number;
	readonly activation: MemoryActivationRecord;
	readonly fingerprintInputs: Readonly<MemoryRecallFingerprintInputs>;
	readonly embedding: { readonly endpoint: string; readonly model: string; readonly deadlineMs: number };
	readonly jevModel: string;
	readonly relevanceMinimum: number;
	readonly indexed: readonly IndexedMemoryCandidate[];
	readonly recent: readonly IndexedMemoryCandidate[];
}

export interface MemoryRecallResult {
	readonly activation: MemoryActivationRecord;
	readonly candidates: readonly MemoryRecallCandidateRecord[];
	readonly fingerprintInputs: Readonly<MemoryRecallFingerprintInputs>;
}

export interface MemoryRecallFingerprintInputs {
	readonly enabled: boolean;
	readonly allowance: number;
	readonly sourceSnapshotFingerprint: string;
	readonly embeddingConfigurationFingerprint: string;
	readonly scene: string;
	readonly scanMessageIds: readonly number[];
	readonly scanTruncated: boolean;
	readonly jevModel: string;
	readonly jevConfigured: boolean;
	readonly relevanceMinimum: number;
	readonly embeddingModel: string;
	readonly embeddingDeadlineMs: number;
}

const blankCandidateStatus = (candidate: IndexedMemoryCandidate["record"], semanticSimilarity: number | null, semanticRank: number | null, recentRank: number | null): MemoryRecallCandidateRecord => ({
	...candidate,
	semanticSimilarity,
	semanticRank,
	recentRank,
	judged: false,
	relevance: null,
	relevanceScore: null,
	retained: false,
	requestIncluded: false,
	admission: "request-limit",
});

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
		let low = 0;
		let high = text.length;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			scene[0]!.text = text.slice(text.length - middle);
			if (tokenxEstimator(render()) <= 4_000) low = middle;
			else high = middle - 1;
		}
		scene[0]!.text = text.slice(text.length - low);
		truncated = true;
	}
	return {
		text: render(),
		messageIds: scene.filter((message) => message.messageId !== 0).map((message) => message.messageId),
		truncated,
	};
};

const initialActivation = (input: {
	enabled: boolean;
	allowance: number;
	eligibleSourceCount: number;
	readyRecordCount: number;
	embeddingModel: string;
	embeddingDeadlineMs: number;
	jevModel: string;
	jevConfigured: boolean;
	relevanceMinimum: number;
	pendingSourceCount: number;
	pendingIndexCount: number;
	failedIndexCount: number;
	failedSourceCount: number;
	unconfigured: boolean;
	sourceSnapshotFingerprint: string;
	embeddingConfigurationFingerprint: string;
	scanMessageIds: number[];
	scanTruncated: boolean;
	scene: string;
}): MemoryActivationRecord => {
	const state: MemoryActivationRecord["state"] = !input.enabled
		? "disabled"
		: input.allowance === 0
			? "allowance-zero"
			: input.readyRecordCount > 0
			? input.pendingSourceCount > 0 || input.pendingIndexCount > 0 || input.failedIndexCount > 0 || input.failedSourceCount > 0 ? "partial" : "ready"
			: input.unconfigured ? "unconfigured"
			: input.pendingIndexCount > 0 || input.pendingSourceCount > 0 ? "rebuilding"
				: input.failedIndexCount > 0 ? "index-failed"
					: input.failedSourceCount > 0 ? "source-failed"
						: "empty";
	return {
		version: 1,
		state,
		allowance: input.allowance,
		eligibleSourceCount: input.eligibleSourceCount,
		readyRecordCount: input.readyRecordCount,
		embeddingModel: input.embeddingModel,
		embeddingDeadlineMs: input.embeddingDeadlineMs,
		jevModel: input.jevModel,
		jevConfigured: input.jevConfigured,
		relevanceMinimum: input.relevanceMinimum,
		pendingSourceCount: input.pendingSourceCount,
		pendingIndexCount: input.pendingIndexCount,
		failedIndexCount: input.failedIndexCount,
		failedSourceCount: input.failedSourceCount,
		sourceSnapshotFingerprint: input.sourceSnapshotFingerprint,
		embeddingConfigurationFingerprint: input.embeddingConfigurationFingerprint,
		scanMessageIds: input.scanMessageIds,
		scanTruncated: input.scanTruncated,
		scene: input.scene,
		semanticShortlistCount: 0,
		recentShortlistCount: 0,
		candidates: [],
		automaticMemoryText: "",
		finalMemoryText: "",
		manuallyEdited: false,
	};
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
	const settings = readMemoryAllowance(input.database, input.conversationId);
	const processing = createMemorySettingsModule(input.database).get();
	const typesafe = createTypesafeSettingsModule(input.database).get();
	const embedding = readMemoryEmbeddingConfiguration(input.database);
	const scene = sceneTextFor(input.messages, input.pendingHumanText, input.humanName);
	const path = input.messages.map((message) => ({
		messageId: message.messageId,
		variantId: message.variantId,
		contentHash: sha256(message.content),
	}));
	const variantIds = [...new Set(input.messages.map((message) => message.variantId))];
	const active = variantIds.length === 0 ? new Set<number>() : new Set(db.select({ id: activeGenerationTable.variant_id }).from(activeGenerationTable).where(inArray(activeGenerationTable.variant_id, variantIds)).all().map((row) => row.id));
	const collections = variantIds.length === 0 ? [] : db.select().from(memoryCollectionTable).where(and(eq(memoryCollectionTable.conversation_id, input.conversationId), inArray(memoryCollectionTable.variant_id, variantIds))).orderBy(asc(memoryCollectionTable.message_id)).all();
	const byVariant = new Map(collections.map((collection) => [collection.variant_id, collection]));
	const fingerprintSources: unknown[] = [];
	const indexed: IndexedMemoryCandidate[] = [];
	let pendingIndexCount = 0;
	let failedIndexCount = 0;
	let failedSourceCount = 0;
	let pendingSourceCount = 0;
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
		const ownership = memoryOwnership(collection.ownership);
		const sourceChanged = collection.source_changed || sha256(message.content) !== collection.source_hash;
		const staleAutomaticSource = ownership === "automatic" && sourceChanged;
		const readiness = readMemoryIndexReadiness(input.database, collection, input.enabled, embedding);
		if (collection.status === "pending" || collection.status === "running") pendingSourceCount += 1;
		if (readiness.status === "unconfigured") unconfigured = true;
		pendingIndexCount += readiness.pendingCount;
		failedIndexCount += readiness.failedCount;
		if (collection.status === "failed" || staleAutomaticSource) failedSourceCount += 1;
		fingerprintSources.push({
			messageId: message.messageId,
			variantId: message.variantId,
			position: message.position,
			revision: collection.revision,
			indexEpoch: collection.index_epoch,
			ownership,
			status: collection.status,
			sourceChanged,
			indexStatus: readiness.status,
			pendingIndexCount: readiness.pendingCount,
			failedIndexCount: readiness.failedCount,
		});
		if (!input.enabled || staleAutomaticSource || collection.status !== "complete" || readiness.status === "disabled" || readiness.status === "unconfigured" || readiness.status === "not-applicable") continue;
		let claims: MemoryCandidateJudgment[];
		try { claims = Value.Parse(memoryCandidates, JSON.parse(collection.claims_json)); } catch { failedSourceCount += 1; continue; }
		for (const [claimIndex, claim] of claims.entries()) {
			const renderedText = renderMemoryClaim(claim);
			const vector = readCachedMemoryVector(input.database, embedding, renderedText);
			if (!vector) continue;
			indexed.push({
				record: {
					identity: `${message.messageId}:${message.variantId}:${collection.revision}:${collection.index_epoch}:${claimIndex}`,
					messageId: message.messageId,
					variantId: message.variantId,
					collectionRevision: collection.revision,
					indexEpoch: collection.index_epoch,
					ownership,
					sourceChanged,
					claimIndex,
					claim: claim.claim,
					attribution: claim.attribution,
					people: claim.people,
					evidence: claim.evidence,
					sourcePosition: message.position,
				},
				renderedText,
				vector,
			});
		}
	}
	const sourceSnapshotFingerprint = sha256(JSON.stringify({ path, sources: fingerprintSources }));
	const embeddingConfigurationFingerprint = sha256(JSON.stringify(embedding));
	const fingerprintInputs = {
		enabled: input.enabled,
		allowance: settings.allowance,
		sourceSnapshotFingerprint,
		embeddingConfigurationFingerprint,
		scene: scene.text,
		scanMessageIds: scene.messageIds,
		scanTruncated: scene.truncated,
		jevModel: typesafe.jevModel,
		jevConfigured: typesafe.credentialConfigured,
		relevanceMinimum: processing.recallRelevanceMinimum,
		embeddingModel: embedding.model,
		embeddingDeadlineMs: embedding.deadlineMs,
	};
	const activation = initialActivation({
		enabled: input.enabled,
		allowance: settings.allowance,
		eligibleSourceCount,
		readyRecordCount: indexed.length,
		embeddingModel: embedding.model,
		embeddingDeadlineMs: embedding.deadlineMs,
		jevModel: typesafe.jevModel,
		jevConfigured: typesafe.credentialConfigured,
		relevanceMinimum: processing.recallRelevanceMinimum,
		pendingSourceCount,
		pendingIndexCount,
		failedIndexCount,
		failedSourceCount,
		unconfigured,
		sourceSnapshotFingerprint,
		embeddingConfigurationFingerprint,
		scanMessageIds: scene.messageIds,
		scanTruncated: scene.truncated,
		scene: scene.text,
	});
	const recent = [...indexed].sort((left, right) => right.record.sourcePosition - left.record.sourcePosition || left.record.identity.localeCompare(right.record.identity)).slice(0, 16);
	return { enabled: input.enabled, allowance: settings.allowance, activation, fingerprintInputs, embedding, jevModel: typesafe.jevModel, relevanceMinimum: processing.recallRelevanceMinimum, indexed, recent };
};

export const evaluateMemoryRecallSnapshot = async (input: {
	database: Database;
	snapshot: MemoryRecallSnapshot;
	fetch?: ModelFetch;
	signal?: AbortSignal;
}): Promise<MemoryRecallResult> => {
	const { snapshot } = input;
	if (!snapshot.enabled || snapshot.allowance === 0 || snapshot.indexed.length === 0) {
		return { activation: snapshot.activation, candidates: [], fingerprintInputs: snapshot.fingerprintInputs };
	}
	let semantic: { candidate: IndexedMemoryCandidate; similarity: number }[] = [];
	if (snapshot.activation.scene.trim().length > 0) {
		const queryVector = (await requestEmbeddings([snapshot.activation.scene], {
			endpoint: snapshot.embedding.endpoint,
			model: snapshot.embedding.model,
			secrets: readMemoryEmbeddingSecrets(input.database),
			timeoutMs: snapshot.embedding.deadlineMs,
			fetch: input.fetch,
		}))[0];
		if (!queryVector) throw new Error("The embedding endpoint returned no Memory query vector.");
		if (snapshot.indexed.some((record) => record.vector.length !== queryVector.length)) throw new Error("A compatible Memory vector has different dimensions from the current query. Rebuild Memory indexes before retrying recall.");
		semantic = snapshot.indexed.map((candidate) => ({ candidate, similarity: cosineSimilarity(queryVector, candidate.vector) }))
			.sort((left, right) => right.similarity - left.similarity || left.candidate.record.identity.localeCompare(right.candidate.record.identity))
			.slice(0, 48);
	}
	const selected = new Map<string, MemoryRecallCandidateRecord>();
	for (const [index, { candidate, similarity }] of semantic.entries()) selected.set(candidate.record.identity, blankCandidateStatus(candidate.record, similarity, index + 1, null));
	for (const [index, candidate] of snapshot.recent.entries()) {
		const existing = selected.get(candidate.record.identity);
		selected.set(candidate.record.identity, existing
			? { ...existing, recentRank: index + 1 }
			: blankCandidateStatus(candidate.record, null, null, index + 1));
	}
	const shortlist = [...selected.values()];
	const judged = await judgeMemoryRecallCandidates(
		shortlist,
		snapshot.activation.scene,
		snapshot.relevanceMinimum,
		createTypesafeSettingsModule(input.database).getCredential() ?? "",
		snapshot.jevModel,
		input.fetch,
		input.signal,
	);
	const ranked = [...judged].filter((candidate) => candidate.judged && candidate.retained)
		.sort((left, right) => (right.relevanceScore ?? -1) - (left.relevanceScore ?? -1) || right.sourcePosition - left.sourcePosition || left.identity.localeCompare(right.identity));
	const activation: MemoryActivationRecord = {
		...snapshot.activation,
		semanticShortlistCount: semantic.length,
		recentShortlistCount: snapshot.recent.length,
		candidates: judged,
	};
	return { activation, candidates: ranked, fingerprintInputs: snapshot.fingerprintInputs };
};
