import type { Database } from "bun:sqlite";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import { createMemorySettingsModule } from "./settings";
import { connectionProfileTable, connectionSecretTable, memoryCollectionTable, memoryEmbeddingCacheTable } from "../database/schema";
import { createConnectionSettingsModule } from "../connection-settings";
import { requestEmbeddings } from "../model-client/embeddings";
import { resolveEmbeddingsRequestUrl } from "../../shared/connection-url";
import type { ModelFetch } from "../model-client/types";
import { memoryCandidates, memoryIndexAttempt } from "../../shared/contract/memory";
import { renderMemoryClaim } from "../../shared/memory-text";
import type { MemoryCandidateJudgment, MemoryIndexReadiness } from "../../shared/contract/memory";
import { indexingVariants, registerMemoryWork } from "./work";
import { sha256 } from "./hash";

const queryBatches = <T>(values: readonly T[]): T[][] => Array.from({ length: Math.ceil(values.length / 500) }, (_, index) => values.slice(index * 500, (index + 1) * 500));

export interface MemoryEmbeddingConfiguration {
	readonly spaceKey: string;
	readonly endpoint: string;
	readonly model: string;
	readonly deadlineMs: number;
}

export type MemoryEmbed = (texts: readonly string[], configuration: MemoryEmbeddingConfiguration, signal: AbortSignal) => Promise<readonly (readonly number[])[]>;

export const readMemoryEmbeddingConfiguration = (database: Database): MemoryEmbeddingConfiguration => {
	const { embeddingProfileId, embeddingModel } = createMemorySettingsModule(database).get();
	const profile = embeddingProfileId === null ? undefined : drizzle(database).select().from(connectionProfileTable).where(and(eq(connectionProfileTable.id, embeddingProfileId), eq(connectionProfileTable.api_format, "embeddings"))).get();
	if (profile === undefined || profile.timeout_ms === null || embeddingModel.length === 0) return { spaceKey: "", endpoint: "", model: "", deadlineMs: 0 };
	const secret = drizzle(database).select({ nonce: connectionSecretTable.nonce }).from(connectionSecretTable).where(eq(connectionSecretTable.profile_id, profile.id)).get();
	const endpoint = resolveEmbeddingsRequestUrl(profile.request_url);
	return { spaceKey: sha256(JSON.stringify([profile.id, secret?.nonce ?? null, endpoint, embeddingModel])), endpoint, model: embeddingModel, deadlineMs: profile.timeout_ms };
};

const readMemoryEmbeddingSecrets = (database: Database) => {
	const { embeddingProfileId } = createMemorySettingsModule(database).get();
	return embeddingProfileId === null ? null : createConnectionSettingsModule(database).getProfileSecrets(embeddingProfileId);
};

export const embedMemoryTexts = (database: Database, fetch?: ModelFetch): MemoryEmbed => (texts, configuration, signal) => {
	if (readMemoryEmbeddingConfiguration(database).spaceKey !== configuration.spaceKey) throw new Error("The embedding model changed before indexing began. Retry indexing under the current configuration.");
	return requestEmbeddings(texts, { endpoint: configuration.endpoint, model: configuration.model, secrets: readMemoryEmbeddingSecrets(database), timeoutMs: configuration.deadlineMs, fetch, signal });
};

export const embedMemoryQuery = (database: Database, text: string, configuration: MemoryEmbeddingConfiguration, fetch?: ModelFetch, signal?: AbortSignal) =>
	requestEmbeddings([text], { endpoint: configuration.endpoint, model: configuration.model, secrets: readMemoryEmbeddingSecrets(database), timeoutMs: configuration.deadlineMs, fetch, signal });

const encodeVector = (vector: readonly number[]) => Buffer.from(new Float32Array(vector).buffer);
const decodeVector = (bytes: Uint8Array): number[] => [...new Float32Array(new Uint8Array(bytes).buffer)];

export const readCachedMemoryVectors = (database: Database, spaceKey: string, texts: readonly string[]): Map<string, number[]> => {
	const byHash = new Map(texts.map((text) => [sha256(text), text]));
	const rows = queryBatches([...byHash.keys()]).flatMap((batch) => drizzle(database).select({ hash: memoryEmbeddingCacheTable.text_hash, vector: memoryEmbeddingCacheTable.vector }).from(memoryEmbeddingCacheTable).where(and(eq(memoryEmbeddingCacheTable.space_key, spaceKey), inArray(memoryEmbeddingCacheTable.text_hash, batch))).all());
	return new Map(rows.map(({ hash, vector }) => [byHash.get(hash)!, decodeVector(vector)]));
};

const cachedHashes = (database: Database, spaceKey: string, texts: readonly string[]): Set<string> =>
	new Set(queryBatches([...new Set(texts.map(sha256))]).flatMap((batch) => drizzle(database).select({ hash: memoryEmbeddingCacheTable.text_hash }).from(memoryEmbeddingCacheTable).where(and(eq(memoryEmbeddingCacheTable.space_key, spaceKey), inArray(memoryEmbeddingCacheTable.text_hash, batch))).all().map(({ hash }) => hash)));

const renderedClaims = (claimsJson: string): string[] => Value.Parse(memoryCandidates, JSON.parse(claimsJson)).map(renderMemoryClaim);

type IndexableCollection = Pick<typeof memoryCollectionTable.$inferSelect, "variant_id" | "ownership" | "source_changed" | "claims_json" | "index_attempt_json">;

const readIndexAttempt = (json: string | null) => {
	try { return json === null ? null : Value.Parse(memoryIndexAttempt, JSON.parse(json)); } catch { return null; }
};

const indexReadiness = (collection: IndexableCollection, configuration: MemoryEmbeddingConfiguration, cached: ReadonlySet<string>, running: ReadonlySet<number>): MemoryIndexReadiness => {
	if (collection.ownership === "automatic" && collection.source_changed) return { status: "disabled", pendingCount: 0, error: "This automatic collection is stale. Reset and re-extract it to index the current source." };
	let texts: string[];
	try { texts = renderedClaims(collection.claims_json); } catch { return { status: "failed", pendingCount: 0, error: "Saved Memory text is invalid and cannot be indexed." }; }
	if (texts.length === 0) return { status: "not-applicable", pendingCount: 0, error: null };
	if (configuration.spaceKey === "") return { status: "unconfigured", pendingCount: texts.length, error: "Choose an embedding model in Memory to index saved Memories." };
	const pendingCount = texts.filter((text) => !cached.has(sha256(text))).length;
	if (pendingCount === 0) return { status: "ready", pendingCount: 0, error: null };
	if (running.has(collection.variant_id)) return { status: "running", pendingCount, error: null };
	const attempt = readIndexAttempt(collection.index_attempt_json);
	if (attempt?.spaceKey === configuration.spaceKey && attempt.error !== null) return { status: "failed", pendingCount: 0, error: attempt.error };
	return { status: "pending", pendingCount, error: null };
};

export const readMemoryIndexReadinessBatch = (database: Database, collections: readonly IndexableCollection[], enabled: boolean, configuration = readMemoryEmbeddingConfiguration(database)): Map<number, MemoryIndexReadiness> => {
	if (!enabled) return new Map(collections.map((collection) => [collection.variant_id, { status: "disabled", pendingCount: 0, error: null }]));
	const cached = cachedHashes(database, configuration.spaceKey, collections.flatMap((collection) => { try { return renderedClaims(collection.claims_json); } catch { return []; } }));
	const running = indexingVariants(database, configuration.spaceKey);
	return new Map(collections.map((collection) => [collection.variant_id, indexReadiness(collection, configuration, cached, running)]));
};

export const readMemoryIndexReadiness = (database: Database, collection: IndexableCollection, enabled: boolean, configuration = readMemoryEmbeddingConfiguration(database)): MemoryIndexReadiness =>
	readMemoryIndexReadinessBatch(database, [collection], enabled, configuration).get(collection.variant_id)!;

export interface MemoryIndexJob {
	readonly variantId: number;
	readonly workEpoch: number;
	readonly configuration: MemoryEmbeddingConfiguration;
	readonly claims: readonly MemoryCandidateJudgment[];
}

const markIndexed = (database: Database, job: Pick<MemoryIndexJob, "variantId" | "workEpoch" | "configuration">, error: string | null) =>
	drizzle(database).update(memoryCollectionTable).set({ index_attempt_json: JSON.stringify({ spaceKey: job.configuration.spaceKey, error }) }).where(and(eq(memoryCollectionTable.variant_id, job.variantId), eq(memoryCollectionTable.work_epoch, job.workEpoch))).run();

export const claimMemoryIndexJob = (database: Database): MemoryIndexJob | undefined => {
	if (!createMemorySettingsModule(database).get().enabled) return undefined;
	const configuration = readMemoryEmbeddingConfiguration(database);
	if (configuration.spaceKey === "") return undefined;
	const row = database.query<{ variant_id: number; work_epoch: number; claims_json: string }, [string, string]>(`
		SELECT c.variant_id, c.work_epoch, c.claims_json FROM memory_collection c
		WHERE c.status = 'complete' AND c.claims_json <> '[]' AND NOT (c.ownership = 'automatic' AND c.source_changed)
			AND (c.index_attempt_json IS NULL OR json_extract(c.index_attempt_json, '$.spaceKey') <> ?1) AND c.variant_id NOT IN (SELECT value FROM json_each(?2))
			AND EXISTS (
				SELECT 1 FROM conversation_prompt_preset p
				JOIN prompt_preset_block b ON b.preset_id = p.prompt_preset_id
				WHERE p.conversation_id = c.conversation_id AND b.reference = 'memory' AND b.enabled = 1
			)
		ORDER BY c.updated_at LIMIT 1`).get(configuration.spaceKey, JSON.stringify([...indexingVariants(database, configuration.spaceKey)]));
	if (!row) return undefined;
	const job = { variantId: row.variant_id, workEpoch: row.work_epoch, configuration };
	try { return { ...job, claims: Value.Parse(memoryCandidates, JSON.parse(row.claims_json)) }; }
	catch { markIndexed(database, job, "Saved Memory text is invalid and cannot be indexed."); return undefined; }
};

export const runMemoryIndexJob = async (database: Database, job: MemoryIndexJob, embed: MemoryEmbed, shutdown: AbortSignal) => {
	const { signal, unregister } = registerMemoryWork(database, job.variantId, job.configuration.spaceKey);
	try {
		const texts = [...new Set(job.claims.map(renderMemoryClaim))];
		const cached = cachedHashes(database, job.configuration.spaceKey, texts);
		const missing = texts.filter((text) => !cached.has(sha256(text)));
		const vectors = missing.length === 0 ? [] : await embed(missing, job.configuration, AbortSignal.any([shutdown, signal]));
		if (vectors.length !== missing.length || vectors.some((vector) => vector.length === 0)) throw new Error("The embedding endpoint returned an incomplete Memory index.");
		database.transaction(() => {
			for (const [index, text] of missing.entries()) drizzle(database).insert(memoryEmbeddingCacheTable).values({ space_key: job.configuration.spaceKey, text_hash: sha256(text), vector: encodeVector(vectors[index]!) }).onConflictDoNothing().run();
			markIndexed(database, job, null);
		}).immediate();
	} catch (error) {
		if (!shutdown.aborted && !signal.aborted) markIndexed(database, job, error instanceof Error ? error.message.slice(0, 1024) : "Memory indexing failed.");
	} finally { unregister(); }
};
