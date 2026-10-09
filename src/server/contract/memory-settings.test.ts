import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createMemorySettingsRoutes } from "./memory-settings";

const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, {
	headers: { "content-type": "application/json", ...init?.headers },
	...init,
});
const apply = (fields: Record<string, boolean | number | string | null>) => request("/api/memory-settings/commands", {
	method: "POST",
	body: JSON.stringify({ expectedRevision: 0, enabled: true, extractionProfileId: null, extractionModel: "", contextLimit: 16384, outputReserve: 2048, safetyAllowance: 500, retainProbabilityMinimum: 0.6, decisionProfileId: null, decisionModel: "", decisionStateTokenLimit: 16000, recallRelevanceMinimum: 1.5, embeddingProfileId: null, embeddingModel: "", ...fields }),
});

describe("Memory Settings public contract", () => {
	let database: Database;
	let app: ReturnType<typeof createMemorySettingsRoutes>;
	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		app = createMemorySettingsRoutes(database);
	});
	afterEach(() => database.close());

	test("selects an independent System One Decision Model and rejects chat profiles", async () => {
		const insert = (format: string) => database.query<{ id: number }, [string]>("INSERT INTO connection_profile (display_name, api_format, request_url, model_backend, adapter, timeout_ms) VALUES ('Decision test', ?, 'http://localhost:8000/v1/', 'automatic', 'openai-compatible', 15000) RETURNING id").get(format)!.id;
		const chat = insert("chat-completions");
		const fields = { decisionProfileId: chat, decisionModel: "clef", decisionStateTokenLimit: 2000, retainProbabilityMinimum: 0.6 };
		const wrong = await app.handle(apply(fields));
		expect(wrong.status).toBe(422);
		expect(await wrong.text()).toContain("System One");
		database.query("DELETE FROM connection_profile WHERE id = ?").run(chat);
		const decisions = insert("system-one");
		const saved = await app.handle(apply({ ...fields, decisionProfileId: decisions }));
		expect(saved.status).toBe(200);
		expect(await saved.json()).toMatchObject({ settings: { decisionProfileId: decisions, decisionModel: "clef", decisionStateTokenLimit: 2000, retainProbabilityMinimum: 0.6 } });
	});

	test("uses independent extraction defaults", async () => {
		const initial = await app.handle(request("/api/memory-settings"));
		expect(await initial.json()).toEqual({ revision: 0, enabled: true, extractionProfileId: null, extractionModel: "", contextLimit: 16384, outputReserve: 2048, safetyAllowance: 500, retainProbabilityMinimum: 0.6, decisionProfileId: null, decisionModel: "", decisionStateTokenLimit: 16000, recallRelevanceMinimum: 1.5, embeddingProfileId: null, embeddingModel: "" });
	});

	test("returns authoritative conflict state, validates limits and reports a deleted chosen Profile", async () => {
		const stale = await app.handle(apply({ expectedRevision: 8 }));
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({ outcome: "conflict", actualRevision: 0, currentSettings: { revision: 0 } });
		const invalid = await app.handle(apply({ contextLimit: 0 }));
		expect(invalid.status).toBe(422);
		expect(await invalid.text()).toContain("positive whole numbers");

		const profile = database.query<{ id: number }, []>("INSERT INTO connection_profile (display_name, api_format, request_url, model_backend, adapter) VALUES ('Rememberer', 'chat-completions', 'https://example.test/v1/chat/completions', 'automatic', 'openai-compatible') RETURNING id").get();
		if (!profile) throw new Error("Memory profile fixture failed.");
		const configured = await app.handle(apply({ extractionProfileId: profile.id, extractionModel: "writer-mini", contextLimit: 12000, outputReserve: 1200, safetyAllowance: 100 }));
		expect(configured.status).toBe(200);
		database.query("DELETE FROM connection_profile WHERE id = ?").run(profile.id);
		const read = await app.handle(request("/api/memory-settings"));
		expect(await read.json()).toMatchObject({ extractionProfileId: profile.id });
		const missing = await app.handle(apply({ expectedRevision: 1, extractionProfileId: profile.id, extractionModel: "writer-mini", contextLimit: 12000, outputReserve: 1200, safetyAllowance: 100 }));
		expect(missing.status).toBe(422);
		expect(await missing.text()).toContain("no longer exists");
	});

	test("keeps chat models for extraction and Embeddings connections for recall", async () => {
		const insert = (name: string, format: string) => database.query<{ id: number }, [string, string]>("INSERT INTO connection_profile (display_name, api_format, request_url, model_backend, adapter, timeout_ms) VALUES (?, ?, 'https://example.test/v1/', 'automatic', 'openai-compatible', 5000) RETURNING id").get(name, format)?.id;
		const chat = insert("Writer", "chat-completions");
		const embeddings = insert("Vectors", "embeddings");
		const wrongExtraction = await app.handle(apply({ extractionProfileId: embeddings ?? null, extractionModel: "text-embedding-3-small" }));
		expect(wrongExtraction.status).toBe(422);
		expect(await wrongExtraction.text()).toContain("chat connection");
		const wrongEmbedding = await app.handle(apply({ embeddingProfileId: chat ?? null, embeddingModel: "writer-mini" }));
		expect(wrongEmbedding.status).toBe(422);
		expect(await wrongEmbedding.text()).toContain("Embeddings connection");
		const configured = await app.handle(apply({ extractionProfileId: chat ?? null, extractionModel: "writer-mini", embeddingProfileId: embeddings ?? null, embeddingModel: "text-embedding-3-small" }));
		expect(configured.status).toBe(200);
	});
});
