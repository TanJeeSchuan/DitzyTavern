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
});

