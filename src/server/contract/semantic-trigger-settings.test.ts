import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createSemanticTriggerSettingsRoutes } from "./semantic-trigger-settings";

let database: Database;
beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
afterEach(() => database.close());
const command = (fields: Record<string, string | number | null> = {}) => new Request("http://localhost/api/semantic-trigger-settings/commands",
	{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "apply", expectedRevision: 0,
	decisionProfileId: null, decisionModel: "", decisionStateTokenLimit: 16000, triggerThreshold: 0.5, ...fields }) });

test("Semantic Trigger selection starts off and applies with revision conflicts and validation", async () => {
	const app = createSemanticTriggerSettingsRoutes(database);
	expect(await (await app.handle(new Request("http://localhost/api/semantic-trigger-settings"))).json()).toEqual({ revision: 0,
		decisionProfileId: null, decisionModel: "", decisionStateTokenLimit: 16000, triggerThreshold: 0.5 });
	expect((await app.handle(command({ triggerThreshold: 1.2 }))).status).toBe(422);
	expect((await app.handle(command({ decisionStateTokenLimit: 0 }))).status).toBe(422);
	expect((await app.handle(command({ expectedRevision: 9 }))).status).toBe(409);
	expect(await (await app.handle(command({ triggerThreshold: 0.7 }))).json()).toMatchObject({ outcome: "applied", settings: { revision: 1, triggerThreshold: 0.7 } });
});
