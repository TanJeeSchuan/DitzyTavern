import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { embedAndCacheMemoryTexts, readCachedMemoryVectors, readMemoryEmbeddingConfiguration } from "../memory/indexing";
import { createMemorySettingsModule } from "../memory/settings";
import { createConnectionSettingsModule } from "../connection-settings";
import { connectionProfileDraftOf } from "../../shared/contract/connection-settings";
import { configureMemoryEmbeddings, key } from "./prompt-preset-test-fixtures";

describe("Memory embedding space", () => {
	let database: Database;
	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
	});
	afterEach(() => database.close());

	test.each(["profile", "credential", "header"] as const)("a new embedding %s starts a separate vector cache, and a rename does not", async (change) => {
		const settings = configureMemoryEmbeddings(database, "http://embedding.test/v1/embeddings", "memory-v1");
		const text = "Maren carries Writer's key. (attribution: Narrated event)";
		await embedAndCacheMemoryTexts(database, [text], readMemoryEmbeddingConfiguration(database), async (texts) => texts.map(() => [1, 0]));
		const before = readMemoryEmbeddingConfiguration(database);
		const connections = createConnectionSettingsModule(database);
		const profile = connections.get().profiles.find((item) => item.id === settings.embeddingProfileId)!;
		if (change === "profile") {
			const next = connections.createProfile({ expectedRevision: connections.get().revision, profile: { ...connectionProfileDraftOf(profile), displayName: "Tenant B" }, credential: "tenant-b" }).profiles.find((item) => item.displayName === "Tenant B")!;
			const memory = createMemorySettingsModule(database);
			const { revision, ...current } = memory.get();
			memory.apply({ ...current, expectedRevision: revision, embeddingProfileId: next.id });
		} else if (change === "credential") {
			connections.setCredential({ expectedRevision: connections.get().revision, profileId: profile.id, credential: "tenant-b" });
		} else {
			connections.applyProfile({ expectedRevision: connections.get().revision, profileId: profile.id, profile: connectionProfileDraftOf(profile), headers: [{ operation: "replace", name: "X-Tenant", value: "tenant-b" }] });
		}
		const current = readMemoryEmbeddingConfiguration(database);
		expect(current.spaceKey).not.toBe(before.spaceKey);
		expect(readCachedMemoryVectors(database, before.spaceKey, [text]).get(text)).toEqual([1, 0]);
		expect(readCachedMemoryVectors(database, current.spaceKey, [text]).has(text)).toBe(false);
		const renamed = connections.get().profiles.find((item) => item.id === profile.id)!;
		connections.applyProfile({ expectedRevision: connections.get().revision, profileId: profile.id, profile: { ...connectionProfileDraftOf(renamed), displayName: "Renamed" } });
		expect(readMemoryEmbeddingConfiguration(database)).toEqual(current);
	});
});
