import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { createConnectionSettingsModule } from "../connection-settings";
import { connectionProfileDraftOf } from "../../shared/contract/connection-settings";
import { configureEmbeddings, key } from "../contract/prompt-preset-test-fixtures";
import { embedTexts, readCachedVectors, readEmbeddingConfiguration } from "./embedding";

describe("Embedding space", () => {
	let database: Database;
	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
	});
	afterEach(() => database.close());

	test.each([false, true])("captured embeddings keep their credentials after profile changes, cache=%s", async (cache) => {
		const profileId = configureEmbeddings(database, "http://tenant-a.test/v1/embeddings");
		const configuration = readEmbeddingConfiguration(database, profileId, "memory-v1");
		const requests: { endpoint: string; authorization: string | null }[] = [];
		const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
			requests.push({ endpoint: String(input), authorization: new Headers(init?.headers).get("authorization") });
			if (requests.length === 1) {
				const connections = createConnectionSettingsModule(database);
				const profile = connections.get().profiles.find((item) => item.id === profileId)!;
				connections.applyProfile({ expectedRevision: connections.get().revision, profileId, profile: { ...connectionProfileDraftOf(profile), requestUrl: "http://tenant-b.test/v1/embeddings" } });
				connections.setCredential({ expectedRevision: connections.get().revision, profileId, credential: "tenant-b-secret" });
			}
			return Response.json({ data: [{ embedding: [1, 0] }] });
		};
		await embedTexts(database, ["claim"], configuration, { cache, fetch });
		await embedTexts(database, ["scene"], configuration, { cache, fetch });
		expect(requests).toEqual([
			{ endpoint: "http://tenant-a.test/v1/embeddings", authorization: "Bearer embedding-secret" },
			{ endpoint: "http://tenant-a.test/v1/embeddings", authorization: "Bearer embedding-secret" },
		]);
		expect(JSON.stringify(configuration)).not.toContain("embedding-secret");
		expect(readEmbeddingConfiguration(database, profileId, "memory-v1").spaceKey).not.toBe(configuration.spaceKey);
	});

	test.each(["profile", "credential", "header"] as const)("a new embedding %s starts a separate vector cache, and a rename does not", async (change) => {
		let profileId = configureEmbeddings(database, "http://embedding.test/v1/embeddings");
		const read = () => readEmbeddingConfiguration(database, profileId, "memory-v1");
		const text = "Maren carries Writer's key. (attribution: Narrated event)";
		const fetch = async () => Response.json({ data: [{ embedding: [1, 0] }] });
		await embedTexts(database, [text], read(), { cache: true, fetch });
		const before = read();
		const connections = createConnectionSettingsModule(database);
		const profile = connections.get().profiles.find((item) => item.id === profileId)!;
		if (change === "profile") {
			profileId = connections.createProfile({ expectedRevision: connections.get().revision, profile: { ...connectionProfileDraftOf(profile), displayName: "Tenant B" }, credential: "tenant-b" }).profiles.find((item) => item.displayName === "Tenant B")!.id;
		} else if (change === "credential") {
			connections.setCredential({ expectedRevision: connections.get().revision, profileId: profile.id, credential: "tenant-b" });
		} else {
			connections.applyProfile({ expectedRevision: connections.get().revision, profileId: profile.id, profile: connectionProfileDraftOf(profile), headers: [{ operation: "replace", name: "X-Tenant", value: "tenant-b" }] });
		}
		const current = read();
		expect(current.spaceKey).not.toBe(before.spaceKey);
		expect(readCachedVectors(database, before.spaceKey, [text]).get(text)).toEqual([1, 0]);
		expect(readCachedVectors(database, current.spaceKey, [text]).has(text)).toBe(false);
		const renamed = connections.get().profiles.find((item) => item.id === profileId)!;
		connections.applyProfile({ expectedRevision: connections.get().revision, profileId, profile: { ...connectionProfileDraftOf(renamed), displayName: "Renamed" } });
		expect(read()).toEqual(current);
	});
});
