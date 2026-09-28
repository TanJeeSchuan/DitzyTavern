import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createEmbeddingSettingsRoutes } from "./embedding-settings";

const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, {
	headers: { "content-type": "application/json", ...init?.headers },
	...init,
});

describe("embedding settings transport", () => {
	let database: Database;
	let app: ReturnType<typeof createEmbeddingSettingsRoutes>;
	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		app = createEmbeddingSettingsRoutes(database, { masterKey: new Uint8Array(32).fill(7) });
	});
	afterEach(() => database.close());

	test("keeps the credential out of reads", async () => {
		const initial = await app.handle(request("/api/embedding-settings"));
		expect(await initial.json()).toEqual({ revision: 0, endpoint: "", model: "", deadlineMs: 5000, credentialConfigured: false });
		const applied = await app.handle(request("/api/embedding-settings/commands", {
			method: "POST",
			body: JSON.stringify({ type: "apply", expectedRevision: 0, endpoint: "http://localhost/v1/embeddings", model: "local", deadlineMs: 2500, credential: "secret" }),
		}));
		expect(applied.status).toBe(200);
		expect(JSON.stringify(await applied.json())).not.toContain("secret");
		const read = await app.handle(request("/api/embedding-settings"));
		expect(await read.json()).toMatchObject({ revision: 1, credentialConfigured: true });
	});

	test("rejects stale revisions and invalid endpoint policy", async () => {
		const stale = await app.handle(request("/api/embedding-settings/commands", { method: "POST", body: JSON.stringify({ type: "apply", expectedRevision: 2, endpoint: "http://localhost", model: "m", deadlineMs: 5000 }) }));
		expect(stale.status).toBe(409);
		const invalid = await app.handle(request("/api/embedding-settings/commands", { method: "POST", body: JSON.stringify({ type: "apply", expectedRevision: 0, endpoint: "file:///tmp/embeddings", model: "m", deadlineMs: 5000 }) }));
		expect(invalid.status).toBe(422);
	});

	test("discovers models beside the saved embedding endpoint", async () => {
		const discoveryRequests: { url: string; authorization: string | null }[] = [];
		app = createEmbeddingSettingsRoutes(database, {
			masterKey: new Uint8Array(32).fill(7),
			fetch: async (input, init) => {
				discoveryRequests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
				return Response.json({ data: [{ id: "zeta" }, { id: "alpha" }] });
			},
		});
		await app.handle(request("/api/embedding-settings/commands", {
			method: "POST",
			body: JSON.stringify({ type: "apply", expectedRevision: 0, endpoint: "https://example.com/v1/embeddings", model: "alpha", deadlineMs: 2500, credential: "secret" }),
		}));
		const response = await app.handle(request("/api/embedding-settings/discovery", { method: "POST" }));
		expect(await response.json()).toEqual({ outcome: "success", catalog: ["alpha", "zeta"] });
		expect(discoveryRequests).toEqual([{ url: "https://example.com/v1/models", authorization: "Bearer secret" }]);
	});

	test("tests an unsaved embedding configuration", async () => {
		const embeddingRequests: { url: string; authorization: string | null; body: unknown }[] = [];
		app = createEmbeddingSettingsRoutes(database, {
			masterKey: new Uint8Array(32).fill(7),
			fetch: async (input, init) => {
				embeddingRequests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
				return Response.json({ data: [{ embedding: [0.25, 0.5, 0.75] }] });
			},
		});
		const response = await app.handle(request("/api/embedding-settings/test", {
			method: "POST",
			body: JSON.stringify({ endpoint: "https://example.com/v1/embeddings", model: "draft-model", deadlineMs: 2500, credential: "draft-secret" }),
		}));
		expect(await response.json()).toEqual({ outcome: "success", dimensions: 3 });
		expect(embeddingRequests).toEqual([{
			url: "https://example.com/v1/embeddings",
			authorization: "Bearer draft-secret",
			body: { model: "draft-model", input: ["DitzyTavern embedding test"] },
		}]);
	});
});
