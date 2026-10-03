import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createTypesafeSettingsRoutes } from "./typesafe-settings";

const command = (body: Record<string, boolean | number | string>) => new Request("http://localhost/api/typesafe-settings/commands", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ type: "apply", expectedRevision: 0, jevModel: "jev-1.13.0", loreTriggerMode: "jev", loreTriggerThreshold: 0.5, ...body }),
});
const read = () => new Request("http://localhost/api/typesafe-settings");

describe("Typesafe Settings public contract", () => {
	let database: Database;
	let app: ReturnType<typeof createTypesafeSettingsRoutes>;
	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		app = createTypesafeSettingsRoutes(database, { masterKey: new Uint8Array(32).fill(8) });
	});
	afterEach(() => database.close());

	test("uses Jev defaults and never returns the saved credential", async () => {
		expect(await (await app.handle(read())).json()).toEqual({ revision: 0, jevModel: "jev-1.13.0", loreTriggerMode: "jev", loreTriggerThreshold: 0.5, credentialConfigured: false });
		const saved = await app.handle(command({ credential: "private-typesafe-token", loreTriggerMode: "off", loreTriggerThreshold: 0.7 }));
		expect(saved.status).toBe(200);
		expect(await saved.text()).not.toContain("private-typesafe-token");
		expect(await (await app.handle(read())).json()).toMatchObject({ revision: 1, loreTriggerMode: "off", loreTriggerThreshold: 0.7, credentialConfigured: true });
		expect(database.query("SELECT ciphertext FROM typesafe_settings WHERE id = 1").get()).not.toEqual({ ciphertext: "private-typesafe-token" });
		const reset = await app.handle(command({ expectedRevision: 1, credential: "" }));
		expect(await reset.json()).toMatchObject({ settings: { revision: 2, credentialConfigured: false } });
	});

	test("rejects stale revisions and out-of-range thresholds", async () => {
		const stale = await app.handle(command({ expectedRevision: 8 }));
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({ outcome: "conflict", actualRevision: 0, currentSettings: { credentialConfigured: false } });
		const invalid = await app.handle(command({ loreTriggerThreshold: 1.5 }));
		expect(invalid.status).toBe(422);
		expect(await invalid.text()).toContain("between 0 and 1");
	});
});
