import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createMemorySettingsRoutes } from "./memory-settings";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, {
	headers: { "content-type": "application/json", ...init?.headers },
	...init,
});

describe("Memory Settings public contract", () => {
	let database: Database;
	let app: ReturnType<typeof createMemorySettingsRoutes>;
	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		app = createMemorySettingsRoutes(database, { masterKey: new Uint8Array(32).fill(8) });
	});
	afterEach(() => database.close());

	test("uses independent extraction defaults and never returns its Typesafe secret", async () => {
		const initial = await app.handle(request("/api/memory-settings"));
		expect(await initial.json()).toEqual({ revision: 0, extractionProfileId: null, extractionModel: "", contextLimit: 16384, outputReserve: 2048, safetyAllowance: 500, jevModel: "jev-1.13.0", credentialConfigured: false });
		const saved = await app.handle(request("/api/memory-settings/commands", { method: "POST", body: JSON.stringify({ type: "set-credential", expectedRevision: 0, credential: "private-typesafe-token" }) }));
		expect(saved.status).toBe(200);
		expect(await saved.text()).not.toContain("private-typesafe-token");
		const read = await app.handle(request("/api/memory-settings"));
		expect(await read.json()).toMatchObject({ revision: 1, credentialConfigured: true });
		expect(database.query("SELECT ciphertext FROM memory_secret WHERE id = 1").get()).not.toEqual({ ciphertext: "private-typesafe-token" });
	});

	test("returns authoritative conflict state, validates limits and reports a deleted chosen Profile", async () => {
		const stale = await app.handle(request("/api/memory-settings/commands", { method: "POST", body: JSON.stringify({ type: "set-credential", expectedRevision: 8, credential: "secret" }) }));
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({ outcome: "conflict", actualRevision: 0, currentSettings: { credentialConfigured: false } });
		const invalid = await app.handle(request("/api/memory-settings/commands", { method: "POST", body: JSON.stringify({ type: "apply", expectedRevision: 0, extractionProfileId: null, extractionModel: "", contextLimit: 0, outputReserve: 2048, safetyAllowance: 500, jevModel: "jev-1.13.0" }) }));
		expect(invalid.status).toBe(422);
		expect(await invalid.text()).toContain("positive whole numbers");

		const profile = database.query<{ id: number }, []>("INSERT INTO connection_profile (display_name, api_format, request_url, model_backend, adapter) VALUES ('Rememberer', 'chat-completions', 'https://example.test/v1/chat/completions', 'automatic', 'openai-compatible') RETURNING id").get();
		if (!profile) throw new Error("Memory profile fixture failed.");
		const configured = await app.handle(request("/api/memory-settings/commands", { method: "POST", body: JSON.stringify({ type: "apply", expectedRevision: 0, extractionProfileId: profile.id, extractionModel: "writer-mini", contextLimit: 12000, outputReserve: 1200, safetyAllowance: 100, jevModel: "jev-1.13.0" }) }));
		expect(configured.status).toBe(200);
		database.query("DELETE FROM connection_profile WHERE id = ?").run(profile.id);
		const read = await app.handle(request("/api/memory-settings"));
		expect(await read.json()).toMatchObject({ extractionProfileId: profile.id });
		const missing = await app.handle(request("/api/memory-settings/commands", { method: "POST", body: JSON.stringify({ type: "apply", expectedRevision: 1, extractionProfileId: profile.id, extractionModel: "writer-mini", contextLimit: 12000, outputReserve: 1200, safetyAllowance: 100, jevModel: "jev-1.13.0" }) }));
		expect(missing.status).toBe(422);
		expect(await missing.text()).toContain("no longer exists");
	});

	test("keeps settings and its encrypted credential across a SQLite reopen", async () => {
		const directory = mkdtempSync(join(tmpdir(), "ditzy-memory-settings-"));
		const path = join(directory, "memory.sqlite");
		const masterKey = new Uint8Array(32).fill(17);
		try {
			const first = openInitializedDatabase({ path });
			const save = createMemorySettingsRoutes(first, { masterKey });
			const response = await save.handle(request("/api/memory-settings/commands", { method: "POST", body: JSON.stringify({ type: "set-credential", expectedRevision: 0, credential: "durable-secret" }) }));
			expect(response.status).toBe(200);
			first.close();

			const second = openInitializedDatabase({ path });
			try {
				const read = await createMemorySettingsRoutes(second, { masterKey }).handle(request("/api/memory-settings"));
				const body = await read.text();
				expect(body).toContain('"revision":1');
				expect(body).toContain('"credentialConfigured":true');
				expect(body).not.toContain("durable-secret");
				expect(second.query("SELECT ciphertext FROM memory_secret WHERE id = 1").get()).not.toEqual({ ciphertext: "durable-secret" });
			} finally { second.close(); }
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});
});
