import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createMemorySettingsRoutes } from "./memory-settings";

const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, {
	headers: { "content-type": "application/json", ...init?.headers },
	...init,
});
const apply = (fields: Record<string, number | string | null>) => request("/api/memory-settings/commands", {
	method: "POST",
	body: JSON.stringify({ expectedRevision: 0, extractionProfileId: null, extractionModel: "", contextLimit: 16384, outputReserve: 2048, safetyAllowance: 500, usefulnessConfidenceGate: 0.3, recallRelevanceMinimum: 1.5, ...fields }),
});

describe("Memory Settings public contract", () => {
	let database: Database;
	let app: ReturnType<typeof createMemorySettingsRoutes>;
	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		app = createMemorySettingsRoutes(database);
	});
	afterEach(() => database.close());

	test("uses independent extraction defaults", async () => {
		const initial = await app.handle(request("/api/memory-settings"));
		expect(await initial.json()).toEqual({ revision: 0, extractionProfileId: null, extractionModel: "", contextLimit: 16384, outputReserve: 2048, safetyAllowance: 500, usefulnessConfidenceGate: 0.3, recallRelevanceMinimum: 1.5 });
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
});
