import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { inspect } from "node:util";
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
		const current = readEmbeddingConfiguration(database, profileId, "memory-v1");
		expect(current.spaceKey).not.toBe(configuration.spaceKey);
		if (cache) {
			expect(readCachedVectors(database, configuration.spaceKey, ["claim", "scene"])).toEqual(new Map([["claim", [1, 0]], ["scene", [1, 0]]]));
			expect(readCachedVectors(database, current.spaceKey, ["claim", "scene"]).size).toBe(0);
		}
	});

	test.each([false, true])("captured embeddings keep custom headers after profile changes, cache=%s", async (cache) => {
		const profileId = configureEmbeddings(database, "http://tenant-a.test/v1/embeddings");
		const connections = createConnectionSettingsModule(database);
		const profile = connectionProfileDraftOf(connections.get().profiles.find((item) => item.id === profileId)!);
		connections.applyProfile({ expectedRevision: connections.get().revision, profileId, profile, headers: [
			{ operation: "replace", name: "Authorization", value: "tenant-a-authorization" },
			{ operation: "replace", name: "X-Tenant", value: "tenant-a-header-secret" },
		] });
		const configuration = readEmbeddingConfiguration(database, profileId, "memory-v1");
		const requests: { authorization: string | null; tenant: string | null }[] = [];
		const fetch = async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			requests.push({ authorization: headers.get("authorization"), tenant: headers.get("x-tenant") });
			if (requests.length === 1) connections.applyProfile({ expectedRevision: connections.get().revision, profileId, profile, headers: [
				{ operation: "replace", name: "Authorization", value: "tenant-b-authorization" },
				{ operation: "replace", name: "X-Tenant", value: "tenant-b-header-secret" },
			] });
			return Response.json({ data: [{ embedding: [1, 0] }] });
		};
		await embedTexts(database, ["claim"], configuration, { cache, fetch });
		await embedTexts(database, ["scene"], configuration, { cache, fetch });
		expect(requests).toEqual([
			{ authorization: "tenant-a-authorization", tenant: "tenant-a-header-secret" },
			{ authorization: "tenant-a-authorization", tenant: "tenant-a-header-secret" },
		]);
		for (const serialized of [JSON.stringify(configuration), JSON.stringify({ ...configuration }), inspect(configuration, { showHidden: true })]) {
			expect(serialized).not.toContain("embedding-secret");
			expect(serialized).not.toContain("tenant-a-authorization");
			expect(serialized).not.toContain("tenant-a-header-secret");
		}
		expect(JSON.stringify(configuration)).toBe(JSON.stringify({ profileId, spaceKey: configuration.spaceKey, endpoint: "http://tenant-a.test/v1/embeddings", model: "memory-v1", deadlineMs: 1_000 }));
	});

	test.each([false, true])("a secretless capture ignores credentials and headers added later, cache=%s", async (cache) => {
		const profileId = configureEmbeddings(database, "http://tenant-a.test/v1/embeddings");
		const connections = createConnectionSettingsModule(database);
		connections.resetCredential({ expectedRevision: connections.get().revision, profileId, confirmed: true });
		expect(connections.getProfileSecrets(profileId)).toBeNull();
		const configuration = readEmbeddingConfiguration(database, profileId, "memory-v1");
		const profile = connectionProfileDraftOf(connections.get().profiles.find((item) => item.id === profileId)!);
		connections.applyProfile({ expectedRevision: connections.get().revision, profileId, profile, credential: "later-secret",
			headers: [{ operation: "replace", name: "X-Tenant", value: "later-header" }] });
		const requests: { authorization: string | null; tenant: string | null }[] = [];
		const fetch = async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			requests.push({ authorization: headers.get("authorization"), tenant: headers.get("x-tenant") });
			return Response.json({ data: [{ embedding: [1, 0] }] });
		};
		await embedTexts(database, ["claim"], configuration, { cache, fetch });
		await embedTexts(database, ["scene"], configuration, { cache, fetch });
		expect(requests).toEqual([{ authorization: null, tenant: null }, { authorization: null, tenant: null }]);
		const current = readEmbeddingConfiguration(database, profileId, "memory-v1");
		expect(current.spaceKey).not.toBe(configuration.spaceKey);
		if (cache) {
			expect(readCachedVectors(database, configuration.spaceKey, ["claim", "scene"])).toEqual(new Map([["claim", [1, 0]], ["scene", [1, 0]]]));
			expect(readCachedVectors(database, current.spaceKey, ["claim", "scene"]).size).toBe(0);
		}
	});

	test.each([false, true])("a forged configuration cannot request or reuse cached vectors, cache=%s", async (cache) => {
		const profileId = configureEmbeddings(database, "http://tenant-a.test/v1/embeddings");
		const configuration = readEmbeddingConfiguration(database, profileId, "memory-v1");
		let requests = 0;
		const fetch = async () => {
			requests += 1;
			return Response.json({ data: [{ embedding: [1, 0] }] });
		};
		await embedTexts(database, ["claim"], configuration, { cache: true, fetch });
		await expect(embedTexts(database, ["claim"], JSON.parse(JSON.stringify(configuration)), { cache, fetch })).rejects.toBeInstanceOf(TypeError);
		expect(requests).toBe(1);
	});

	test("unconfigured embeddings never request a provider", async () => {
		const configuration = readEmbeddingConfiguration(database, null, "memory-v1");
		let requests = 0;
		const fetch = async () => {
			requests += 1;
			return Response.json({ data: [{ embedding: [1, 0] }] });
		};
		await expect(embedTexts(database, ["claim"], configuration, { fetch })).rejects.toThrow("not configured");
		expect(await embedTexts(database, [], configuration, { fetch })).toEqual([]);
		expect(requests).toBe(0);
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
			profileId = connections.createProfile({ expectedRevision: connections.get().revision,
				profile: { ...connectionProfileDraftOf(profile), displayName: "Tenant B" }, credential: "tenant-b" }).profiles.find((item) => item.displayName === "Tenant B")!.id;
		} else if (change === "credential") {
			connections.setCredential({ expectedRevision: connections.get().revision, profileId: profile.id, credential: "tenant-b" });
		} else {
			connections.applyProfile({ expectedRevision: connections.get().revision, profileId: profile.id, profile: connectionProfileDraftOf(profile),
				headers: [{ operation: "replace", name: "X-Tenant", value: "tenant-b" }] });
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
