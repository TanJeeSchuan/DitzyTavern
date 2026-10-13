import type { Database } from "bun:sqlite";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createMemorySettingsModule } from "./settings";
import { connectionProfileTable, connectionSecretTable, memoryEmbeddingCacheTable } from "../database/schema";
import { createConnectionSettingsModule } from "../connection-settings";
import { requestEmbeddings } from "../model-client/embeddings";
import { resolveRequestUrl } from "../../shared/connection-url";
import type { ModelFetch } from "../model-client/types";
import { sha256 } from "./hash";
import { queryBatches } from "../database/query-batches";

const connect = (database: Database) => drizzle(database);

export interface MemoryEmbeddingConfiguration {
	readonly spaceKey: string;
	readonly endpoint: string;
	readonly model: string;
	readonly deadlineMs: number;
}

export const readMemoryEmbeddingConfiguration = (database: Database): MemoryEmbeddingConfiguration => {
	const { embeddingProfileId, embeddingModel } = createMemorySettingsModule(database).get();
	const db = connect(database);
	const profile = embeddingProfileId === null ? undefined : db.select().from(connectionProfileTable).where(and(eq(connectionProfileTable.id, embeddingProfileId), eq(connectionProfileTable.api_format, "embeddings"))).get();
	if (profile === undefined || profile.timeout_ms === null || embeddingModel.length === 0) return { spaceKey: "", endpoint: "", model: "", deadlineMs: 0 };
	const secret = db.select({ nonce: connectionSecretTable.nonce }).from(connectionSecretTable).where(eq(connectionSecretTable.profile_id, profile.id)).get();
	const endpoint = resolveRequestUrl(profile.request_url, profile.api_format);
	return { spaceKey: sha256(JSON.stringify([profile.id, secret?.nonce ?? null, endpoint, embeddingModel])), endpoint, model: embeddingModel, deadlineMs: profile.timeout_ms };
};

export const embedMemoryTexts = (database: Database, texts: readonly string[], configuration: MemoryEmbeddingConfiguration, fetch?: ModelFetch, signal?: AbortSignal) => {
	const { embeddingProfileId } = createMemorySettingsModule(database).get();
	const secrets = embeddingProfileId === null ? null : createConnectionSettingsModule(database).getProfileSecrets(embeddingProfileId);
	return requestEmbeddings(texts, { endpoint: configuration.endpoint, model: configuration.model, secrets, timeoutMs: configuration.deadlineMs, fetch, signal });
};

const encodeVector = (vector: readonly number[]) => Buffer.from(new Float32Array(vector).buffer);
const decodeVector = (bytes: Uint8Array): number[] => [...new Float32Array(new Uint8Array(bytes).buffer)];

export const readCachedMemoryVectors = (database: Database, spaceKey: string, texts: readonly string[]): Map<string, number[]> => {
	const db = connect(database);
	const byHash = new Map(texts.map((text) => [sha256(text), text]));
	const rows = queryBatches([...byHash.keys()]).flatMap((batch) => db
		.select({ hash: memoryEmbeddingCacheTable.text_hash, vector: memoryEmbeddingCacheTable.vector })
		.from(memoryEmbeddingCacheTable)
		.where(and(eq(memoryEmbeddingCacheTable.space_key, spaceKey), inArray(memoryEmbeddingCacheTable.text_hash, batch)))
		.all());
	return new Map(rows.map(({ hash, vector }) => [byHash.get(hash)!, decodeVector(vector)]));
};

// @approved
//  Embeds the texts the cache lacks in one request and caches them, returning
// every text's vector. The cache is keyed by text, so a claim shared by two
// Variants, or kept through a Writer edit, is embedded once.
export const embedAndCacheMemoryTexts = async (
	database: Database,
	texts: readonly string[],
	configuration: MemoryEmbeddingConfiguration,
	embed: (texts: readonly string[], configuration: MemoryEmbeddingConfiguration) => Promise<readonly (readonly number[])[]>,
): Promise<Map<string, readonly number[]>> => {
	const vectors: Map<string, readonly number[]> = readCachedMemoryVectors(database, configuration.spaceKey, texts);
	const missing = [...new Set(texts)].filter((text) => !vectors.has(text));
	if (missing.length === 0) return vectors;
	const embedded = await embed(missing, configuration);
	if (embedded.length !== missing.length || embedded.some((vector) => vector.length === 0)) throw new Error("The embedding endpoint returned an incomplete Memory index.");
	const db = connect(database);
	database.transaction(() => {
		for (const [index, text] of missing.entries()) {
			db.insert(memoryEmbeddingCacheTable)
				.values({ space_key: configuration.spaceKey, text_hash: sha256(text), vector: encodeVector(embedded[index]!) })
				.onConflictDoNothing()
				.run();
			vectors.set(text, embedded[index]!);
		}
	}).immediate();
	return vectors;
};
