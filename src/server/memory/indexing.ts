import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { readConversationPromptPreset } from "../conversation/prompt-preset";
import { activeGenerationTable, memoryCollectionTable, memoryEmbeddingCacheTable, memoryIndexWorkTable, messageTable, messageVariantTable } from "../database/schema";
import { createEmbeddingSettingsModule } from "../embedding-settings";
import { requestEmbeddings } from "../lorebook/embedding-client";
import type { ModelFetch } from "../model-client/types";
import { memoryCandidates } from "../../shared/contract/memory";
import { hasEnabledMemorySlot } from "../../shared/contract/prompt-preset";
import { renderMemoryClaim } from "../../shared/memory-text";
import type { MemoryCandidateJudgment } from "./extraction";
import { sha256 } from "./hash";

const memoryVector = Type.Array(Type.Number(), { minItems: 1 });

export interface MemoryEmbeddingConfiguration {
	readonly endpoint: string;
	readonly model: string;
	readonly deadlineMs: number;
}

export interface MemoryIndexReadiness {
	readonly status: "ready" | "pending" | "running" | "failed" | "disabled" | "unconfigured" | "not-applicable";
	readonly pendingCount: number;
	readonly failedCount: number;
	readonly error: string | null;
}

export interface MemoryIndexJob {
	readonly variantId: number;
	readonly conversationId: number;
	readonly messageId: number;
	readonly revision: number;
	readonly epoch: number;
	readonly endpoint: string;
	readonly model: string;
	readonly deadlineMs: number;
	readonly claims: readonly MemoryCandidateJudgment[];
}

export class StaleMemoryIndexRevisionError extends Error {
	constructor() { super("This Memory collection changed in another session."); }
}

const activeIndexControllers = new WeakMap<Database, Map<number, Set<AbortController>>>();

export const registerMemoryIndexController = (database: Database, variantId: number, controller: AbortController): (() => void) => {
	let byVariant = activeIndexControllers.get(database);
	if (!byVariant) {
		byVariant = new Map();
		activeIndexControllers.set(database, byVariant);
	}
	const controllers = byVariant.get(variantId) ?? new Set<AbortController>();
	controllers.add(controller);
	byVariant.set(variantId, controllers);
	return () => {
		controllers.delete(controller);
		if (controllers.size === 0) byVariant.delete(variantId);
	};
};

export const cancelMemoryIndexWork = (database: Database, variantId: number): void => {
	for (const controller of activeIndexControllers.get(database)?.get(variantId) ?? []) controller.abort();
};

const currentConfiguration = (database: Database): MemoryEmbeddingConfiguration => {
	const settings = createEmbeddingSettingsModule(database).get();
	return { endpoint: settings.endpoint, model: settings.model, deadlineMs: settings.deadlineMs };
};

export const readMemoryEmbeddingConfiguration = currentConfiguration;

export const isMemoryEnabledForConversation = (database: Database, conversationId: number): boolean =>
	hasEnabledMemorySlot(readConversationPromptPreset(database, conversationId)?.slots ?? []);

const parseVector = (serialized: string): readonly number[] | null => {
	try {
		const value: unknown = JSON.parse(serialized);
		return Value.Check(memoryVector, value) ? Value.Parse(memoryVector, value) : null;
	} catch { return null; }
};

export const readCachedMemoryVector = (database: Database, configuration: MemoryEmbeddingConfiguration, renderedText: string): readonly number[] | null => {
	const row = drizzle(database).select().from(memoryEmbeddingCacheTable).where(and(
		eq(memoryEmbeddingCacheTable.endpoint, configuration.endpoint),
		eq(memoryEmbeddingCacheTable.model, configuration.model),
		eq(memoryEmbeddingCacheTable.text_hash, sha256(renderedText)),
	)).get();
	if (!row || row.rendered_text !== renderedText) return null;
	return parseVector(row.vector_json);
};

const cachedTexts = (database: Database, configuration: MemoryEmbeddingConfiguration, texts: readonly string[]): Set<string> => {
	if (texts.length === 0) return new Set();
	const hashes = [...new Set(texts.map(sha256))];
	const rows = drizzle(database).select().from(memoryEmbeddingCacheTable).where(and(
		eq(memoryEmbeddingCacheTable.endpoint, configuration.endpoint),
		eq(memoryEmbeddingCacheTable.model, configuration.model),
		inArray(memoryEmbeddingCacheTable.text_hash, hashes),
	)).all();
	const byHash = new Map(rows.map((row) => [row.text_hash, row]));
	return new Set(texts.filter((text) => {
		const row = byHash.get(sha256(text));
		return row?.rendered_text === text && parseVector(row.vector_json) !== null;
	}));
};

const parsedClaims = (serialized: string): MemoryCandidateJudgment[] => Value.Parse(memoryCandidates, JSON.parse(serialized));
type MemoryCollectionRow = typeof memoryCollectionTable.$inferSelect;

export const readMemoryIndexReadiness = (
	database: Database,
	collection: typeof memoryCollectionTable.$inferSelect,
	enabled: boolean,
	configuration = currentConfiguration(database),
): MemoryIndexReadiness => {
	if (!enabled) return { status: "disabled", pendingCount: 0, failedCount: 0, error: null };
	if (collection.ownership === "automatic" && collection.source_changed) return { status: "disabled", pendingCount: 0, failedCount: 0, error: "This automatic collection is stale. Reset and re-extract it to index the current source." };
	let claims: MemoryCandidateJudgment[];
	try { claims = parsedClaims(collection.claims_json); } catch { return { status: "failed", pendingCount: 0, failedCount: 1, error: "Saved Memory text is invalid and cannot be indexed." }; }
	if (claims.length === 0) return { status: "not-applicable", pendingCount: 0, failedCount: 0, error: null };
	if (configuration.endpoint.length === 0 || configuration.model.length === 0) {
		return { status: "unconfigured", pendingCount: claims.length, failedCount: 0, error: "Configure the embedding endpoint and model to index saved Memories." };
	}
	const texts = claims.map(renderMemoryClaim);
	const ready = cachedTexts(database, configuration, texts).size;
	const pendingCount = texts.length - ready;
	if (pendingCount === 0) return { status: "ready", pendingCount: 0, failedCount: 0, error: null };
	const job = drizzle(database).select().from(memoryIndexWorkTable).where(eq(memoryIndexWorkTable.variant_id, collection.variant_id)).get();
	if (!job || job.collection_revision !== collection.revision || job.epoch !== collection.index_epoch || job.endpoint !== configuration.endpoint || job.model !== configuration.model) {
		return { status: "pending", pendingCount, failedCount: 0, error: null };
	}
	if (job.status === "failed") return { status: "failed", pendingCount: 0, failedCount: pendingCount, error: job.error };
	return { status: job.status === "running" ? "running" : "pending", pendingCount, failedCount: 0, error: null };
};

const cacheMissingTexts = (database: Database, configuration: MemoryEmbeddingConfiguration, claims: readonly MemoryCandidateJudgment[]) => {
	const uniqueTexts = [...new Set(claims.map(renderMemoryClaim))];
	const ready = cachedTexts(database, configuration, uniqueTexts);
	return uniqueTexts.filter((text) => !ready.has(text));
};

const scheduleInsideTransaction = (
	database: Database,
	collection: MemoryCollectionRow,
	configuration: MemoryEmbeddingConfiguration,
	force: boolean,
): boolean => {
	const db = drizzle(database);
	let claims: MemoryCandidateJudgment[];
	try { claims = parsedClaims(collection.claims_json); } catch { return false; }
	if (claims.length === 0) {
		db.update(memoryCollectionTable).set({ index_epoch: collection.index_epoch + 1 }).where(eq(memoryCollectionTable.variant_id, collection.variant_id)).run();
		db.delete(memoryIndexWorkTable).where(eq(memoryIndexWorkTable.variant_id, collection.variant_id)).run();
		return false;
	}
	if (collection.status !== "complete" || (collection.ownership === "automatic" && collection.source_changed)) {
		db.update(memoryCollectionTable).set({ index_epoch: collection.index_epoch + 1 }).where(eq(memoryCollectionTable.variant_id, collection.variant_id)).run();
		db.delete(memoryIndexWorkTable).where(eq(memoryIndexWorkTable.variant_id, collection.variant_id)).run();
		return false;
	}
	if (!isMemoryEnabledForConversation(database, collection.conversation_id)) {
		db.update(memoryCollectionTable).set({ index_epoch: collection.index_epoch + 1 }).where(eq(memoryCollectionTable.variant_id, collection.variant_id)).run();
		db.delete(memoryIndexWorkTable).where(eq(memoryIndexWorkTable.variant_id, collection.variant_id)).run();
		return false;
	}
	const existing = db.select().from(memoryIndexWorkTable).where(eq(memoryIndexWorkTable.variant_id, collection.variant_id)).get();
	const missing = cacheMissingTexts(database, configuration, claims);
	if (missing.length === 0 && !force) {
		db.update(memoryCollectionTable).set({ index_epoch: collection.index_epoch + 1 }).where(eq(memoryCollectionTable.variant_id, collection.variant_id)).run();
		db.delete(memoryIndexWorkTable).where(eq(memoryIndexWorkTable.variant_id, collection.variant_id)).run();
		return false;
	}
	if (!force && existing && existing.collection_revision === collection.revision && existing.epoch === collection.index_epoch && existing.endpoint === configuration.endpoint && existing.model === configuration.model && existing.deadline_ms === configuration.deadlineMs) return false;
	const epoch = collection.index_epoch + 1;
	db.update(memoryCollectionTable).set({ index_epoch: epoch }).where(eq(memoryCollectionTable.variant_id, collection.variant_id)).run();
	db.insert(memoryIndexWorkTable).values({
		variant_id: collection.variant_id,
		collection_revision: collection.revision,
		epoch,
		endpoint: configuration.endpoint,
		model: configuration.model,
		deadline_ms: configuration.deadlineMs,
		status: "pending",
		error: null,
		updated_at: new Date().toISOString(),
	}).onConflictDoUpdate({
		target: memoryIndexWorkTable.variant_id,
		set: { collection_revision: collection.revision, epoch, endpoint: configuration.endpoint, model: configuration.model, deadline_ms: configuration.deadlineMs, status: "pending", error: null, updated_at: new Date().toISOString() },
	}).run();
	return true;
};

export const queueMemoryIndexForVariant = (database: Database, variantId: number, force = false, configuration = currentConfiguration(database)): boolean => {
	const queued = database.transaction(() => {
	const collection = drizzle(database).select().from(memoryCollectionTable).where(eq(memoryCollectionTable.variant_id, variantId)).get();
	return collection ? scheduleInsideTransaction(database, collection, configuration, force) : false;
}).immediate();
	if (queued) cancelMemoryIndexWork(database, variantId);
	return queued;
};

const scheduleCollections = (database: Database, collections: readonly MemoryCollectionRow[], configuration: MemoryEmbeddingConfiguration): number => {
	let queued = 0;
	for (const collection of collections) {
		if (database.transaction(() => scheduleInsideTransaction(database, collection, configuration, false)).immediate()) {
			queued += 1;
			cancelMemoryIndexWork(database, collection.variant_id);
		}
	}
	return queued;
};

export const queueMemoryIndexingForConversation = (database: Database, conversationId: number, configuration = currentConfiguration(database)): number => {
	const collections = drizzle(database).select().from(memoryCollectionTable).where(eq(memoryCollectionTable.conversation_id, conversationId)).orderBy(asc(memoryCollectionTable.message_id)).all();
	return scheduleCollections(database, collections, configuration);
};

export const queueAllMemoryIndexing = (database: Database, configuration = currentConfiguration(database)): number => {
	const collections = drizzle(database).select().from(memoryCollectionTable).all();
	return scheduleCollections(database, collections, configuration);
};

export const retryMemoryIndexing = (database: Database, conversationId: number, variantId: number, expectedRevision: number) => {
	const db = drizzle(database);
	const collection = db.select().from(memoryCollectionTable).where(and(
		eq(memoryCollectionTable.variant_id, variantId),
		eq(memoryCollectionTable.conversation_id, conversationId),
	)).get();
	if (!collection) throw new Error("This source has no saved Memory collection to index.");
	if (collection.revision !== expectedRevision) throw new StaleMemoryIndexRevisionError();
	if (collection.status !== "complete") throw new Error("Indexing requires a completed saved Memory collection.");
	if (!isMemoryEnabledForConversation(database, conversationId)) throw new Error("Enable Memory in the selected Prompt Preset before indexing saved Memories.");
	queueMemoryIndexForVariant(database, variantId, true);
	const current = db.select().from(memoryCollectionTable).where(eq(memoryCollectionTable.variant_id, variantId)).get();
	if (!current) throw new Error("This source has no saved Memory collection to index.");
	return readMemoryIndexReadiness(database, current, true);
};

export const claimMemoryIndexWork = (database: Database): MemoryIndexJob | undefined => database.transaction(() => {
	const db = drizzle(database);
	const work = db.select().from(memoryIndexWorkTable).where(eq(memoryIndexWorkTable.status, "pending")).orderBy(asc(memoryIndexWorkTable.updated_at)).get();
	if (!work) return undefined;
	const collection = db.select().from(memoryCollectionTable).where(eq(memoryCollectionTable.variant_id, work.variant_id)).get();
	if (!collection) {
		db.delete(memoryIndexWorkTable).where(eq(memoryIndexWorkTable.variant_id, work.variant_id)).run();
		return undefined;
	}
	const configuration = currentConfiguration(database);
	if (collection.revision !== work.collection_revision || collection.index_epoch !== work.epoch || collection.status !== "complete" || (collection.ownership === "automatic" && collection.source_changed) || !isMemoryEnabledForConversation(database, collection.conversation_id)) {
		db.delete(memoryIndexWorkTable).where(and(eq(memoryIndexWorkTable.variant_id, work.variant_id), eq(memoryIndexWorkTable.epoch, work.epoch))).run();
		return undefined;
	}
	if (work.endpoint !== configuration.endpoint || work.model !== configuration.model || work.deadline_ms !== configuration.deadlineMs) {
		scheduleInsideTransaction(database, collection, configuration, false);
		return undefined;
	}
	const changed = db.update(memoryIndexWorkTable).set({ status: "running", updated_at: new Date().toISOString() }).where(and(
		eq(memoryIndexWorkTable.variant_id, work.variant_id), eq(memoryIndexWorkTable.status, "pending"), eq(memoryIndexWorkTable.epoch, work.epoch),
	)).returning({ variantId: memoryIndexWorkTable.variant_id }).get();
	if (!changed) return undefined;
	let claims: MemoryCandidateJudgment[];
	try { claims = parsedClaims(collection.claims_json); } catch {
		db.update(memoryIndexWorkTable).set({ status: "failed", error: "Saved Memory text is invalid and cannot be indexed." }).where(eq(memoryIndexWorkTable.variant_id, work.variant_id)).run();
		return undefined;
	}
	return { variantId: work.variant_id, conversationId: collection.conversation_id, messageId: collection.message_id, revision: work.collection_revision, epoch: work.epoch, endpoint: work.endpoint, model: work.model, deadlineMs: work.deadline_ms, claims };
}).immediate();

export const embedMemoryJob = async (database: Database, job: MemoryIndexJob, fetch?: ModelFetch, signal?: AbortSignal) => {
	if (job.endpoint.length === 0 || job.model.length === 0) throw new Error("Configure the embedding endpoint and model to index saved Memories.");
	const config = currentConfiguration(database);
	if (config.endpoint !== job.endpoint || config.model !== job.model || config.deadlineMs !== job.deadlineMs) throw new Error("Embedding settings changed before indexing began. Retry indexing under the current configuration.");
	const missing = cacheMissingTexts(database, config, job.claims);
	if (missing.length === 0) return [] as const;
	const settings = createEmbeddingSettingsModule(database);
	const vectors = await requestEmbeddings(missing, { ...config, credential: settings.getCredential(), timeoutMs: job.deadlineMs, fetch, signal });
	return missing.map((renderedText, index) => ({ renderedText, vector: vectors[index]! }));
};

export const publishMemoryIndexVectors = (
	database: Database,
	job: MemoryIndexJob,
	values: readonly { renderedText: string; vector: readonly number[] }[],
): boolean => database.transaction(() => {
	const db = drizzle(database);
	const collection = db.select().from(memoryCollectionTable).where(eq(memoryCollectionTable.variant_id, job.variantId)).get();
	const work = db.select().from(memoryIndexWorkTable).where(eq(memoryIndexWorkTable.variant_id, job.variantId)).get();
	const config = currentConfiguration(database);
	const source = db.select({ id: messageVariantTable.id }).from(messageVariantTable).innerJoin(messageTable, eq(messageVariantTable.message_id, messageTable.id)).where(and(
		eq(messageVariantTable.id, job.variantId), eq(messageTable.conversation_id, job.conversationId),
	)).get();
	const active = db.select({ id: activeGenerationTable.id }).from(activeGenerationTable).where(and(
		eq(activeGenerationTable.variant_id, job.variantId), eq(activeGenerationTable.conversation_id, job.conversationId),
	)).get();
	if (!collection || !source || active || !work || work.status !== "running" || work.epoch !== job.epoch || work.collection_revision !== job.revision || collection.revision !== job.revision || collection.index_epoch !== job.epoch || collection.status !== "complete" || (collection.ownership === "automatic" && collection.source_changed) || !isMemoryEnabledForConversation(database, job.conversationId) || config.endpoint !== job.endpoint || config.model !== job.model || config.deadlineMs !== job.deadlineMs) return false;
	const currentClaims = parsedClaims(collection.claims_json);
	if (JSON.stringify(currentClaims.map(renderMemoryClaim)) !== JSON.stringify(job.claims.map(renderMemoryClaim))) return false;
	for (const { renderedText, vector } of values) {
		const textHash = sha256(renderedText);
		const existing = db.select().from(memoryEmbeddingCacheTable).where(and(
			eq(memoryEmbeddingCacheTable.endpoint, job.endpoint), eq(memoryEmbeddingCacheTable.model, job.model), eq(memoryEmbeddingCacheTable.text_hash, textHash),
		)).get();
		if (existing && existing.rendered_text !== renderedText) throw new Error("A Memory text identity collision prevents indexing.");
		if (existing) continue;
		db.insert(memoryEmbeddingCacheTable).values({ endpoint: job.endpoint, model: job.model, text_hash: textHash, rendered_text: renderedText, vector_json: JSON.stringify(vector), updated_at: new Date().toISOString() }).onConflictDoNothing().run();
	}
	db.delete(memoryIndexWorkTable).where(and(eq(memoryIndexWorkTable.variant_id, job.variantId), eq(memoryIndexWorkTable.epoch, job.epoch))).run();
	return true;
}).immediate();

export const failMemoryIndexWork = (database: Database, job: MemoryIndexJob, error: Error): void => {
	const message = error.message.slice(0, 1024);
	drizzle(database).update(memoryIndexWorkTable).set({ status: "failed", error: message, updated_at: new Date().toISOString() }).where(and(
		eq(memoryIndexWorkTable.variant_id, job.variantId), eq(memoryIndexWorkTable.epoch, job.epoch), eq(memoryIndexWorkTable.status, "running"),
	)).run();
};

export const requeueInterruptedMemoryIndexWork = (database: Database): void => {
	drizzle(database).update(memoryIndexWorkTable).set({ status: "pending", updated_at: new Date().toISOString() }).where(eq(memoryIndexWorkTable.status, "running")).run();
};
