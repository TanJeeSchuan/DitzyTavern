import type { Database } from "bun:sqlite";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { connectionProfileTable, connectionSecretTable, embeddingCacheTable } from "../database/schema";
import { createConnectionSettingsModule } from "../connection-settings";
import { requestEmbeddings } from "../model-client/embeddings";
import { resolveRequestUrl } from "../../shared/connection-url";
import type { ModelFetch } from "../model-client/types";
import { sha256 } from "../hash";
import { queryBatches } from "../database/query-batches";

let secretsOf: (configuration: EmbeddingConfiguration) => Parameters<typeof requestEmbeddings>[1]["secrets"];

/** @approved An embedding model on an embeddings Connection Profile. `spaceKey` names its vector space, so cached vectors never mix across profiles, credentials, endpoints or models. */
export class EmbeddingConfiguration {
	readonly #secrets: Parameters<typeof requestEmbeddings>[1]["secrets"];
	static { secretsOf = (configuration) => configuration.#secrets; }
	constructor(
		readonly profileId: number,
		readonly spaceKey: string,
		readonly endpoint: string,
		readonly model: string,
		readonly deadlineMs: number,
		secrets: Parameters<typeof requestEmbeddings>[1]["secrets"],
	) {
		if (secrets !== null) {
			Object.freeze(secrets.headers);
			Object.freeze(secrets);
		}
		this.#secrets = secrets;
		Object.freeze(this);
	}
}

/** @approved The embedding model `model` on the embeddings Connection Profile `profileId`, or undefined when either is not configured. */
export const readEmbeddingConfiguration = (database: Database, profileId: number | null, model: string): EmbeddingConfiguration | undefined => database.transaction(() => {
	const db = drizzle(database);
	const profile = profileId === null ? undefined : db.select().from(connectionProfileTable)
		.where(and(eq(connectionProfileTable.id, profileId), eq(connectionProfileTable.api_format, "embeddings"))).get();
	if (profile === undefined || profile.timeout_ms === null || model.length === 0) return undefined;
	const secret = db.select({ nonce: connectionSecretTable.nonce }).from(connectionSecretTable).where(eq(connectionSecretTable.profile_id, profile.id)).get();
	const secrets = createConnectionSettingsModule(database).getProfileSecrets(profile.id);
	const endpoint = resolveRequestUrl(profile.request_url, profile.api_format);
	return new EmbeddingConfiguration(profile.id, sha256(JSON.stringify([profile.id, secret?.nonce ?? null, endpoint, model])), endpoint, model, profile.timeout_ms, secrets);
})();

const readVector = (bytes: Uint8Array): Float32Array => new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);

// @approved
//  Cached vectors come back as views over the driver's blob, not as JS number
//  arrays: a Recall decodes ~1,700 vectors of 3,072 floats, and spreading each
//  one through the array iterator cost 142 ms of the 210 ms a recall spent on
//  the cache alone.
export const readCachedVectors = (database: Database, spaceKey: string, texts: readonly string[]): Map<string, Float32Array> => {
	const db = drizzle(database);
	const byHash = new Map(texts.map((text) => [sha256(text), text]));
	const rows = queryBatches([...byHash.keys()]).flatMap((batch) => db
		.select({ hash: embeddingCacheTable.text_hash, vector: embeddingCacheTable.vector })
		.from(embeddingCacheTable)
		.where(and(eq(embeddingCacheTable.space_key, spaceKey), inArray(embeddingCacheTable.text_hash, batch)))
		.all());
	return new Map(rows.map(({ hash, vector }) => [byHash.get(hash)!, readVector(vector)])); // @approved The query selects only hashes byHash holds.
};

// @approved
//  One vector per text, in order. With `cache`, the texts the cache lacks are
// embedded in one request and kept, keyed by text, so a text shared by two
// Variants, or kept through a Writer edit, is embedded once.
export const embedTexts = async (
	database: Database,
	texts: readonly string[],
	configuration: EmbeddingConfiguration,
	{ cache = false, fetch, signal }: { readonly cache?: boolean; readonly fetch?: ModelFetch; readonly signal?: AbortSignal },
): Promise<readonly Float32Array[]> => {
	const secrets = secretsOf(configuration);
	const request = async (missing: readonly string[]): Promise<Float32Array[]> => {
		const embedded = await requestEmbeddings(missing, { endpoint: configuration.endpoint, model: configuration.model, secrets, timeoutMs: configuration.deadlineMs, fetch, signal });
		if (embedded.length !== missing.length || embedded.some((vector) => vector.length === 0)) throw new Error("The embedding endpoint returned an incomplete answer.");
		return embedded.map((vector) => Float32Array.from(vector));
	};
	if (!cache) return request(texts);
	const vectors = readCachedVectors(database, configuration.spaceKey, texts);
	const missing = [...new Set(texts)].filter((text) => !vectors.has(text));
	if (missing.length > 0) {
		/** @approved `request` returned exactly one vector per missing text. */
		const embedded = await request(missing);
		const db = drizzle(database);
		database.transaction(() => {
			for (const [index, text] of missing.entries()) {
				const vector = embedded[index]!;
				db.insert(embeddingCacheTable)
					.values({ space_key: configuration.spaceKey, text_hash: sha256(text), vector: Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength) })
					.onConflictDoNothing()
					.run();
				vectors.set(text, vector);
			}
		}).immediate();
	}
	return texts.map((text) => vectors.get(text)!); // @approved Every text was cached or embedded above.
};
