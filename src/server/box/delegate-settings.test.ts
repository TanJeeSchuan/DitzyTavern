import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtInBoxes, loadBoxes } from "./registry";
import { createConnectionSettingsModule } from "../connection-settings";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { configureDecisionModels } from "../contract/decision-model-test-fixtures";
import { key, profile } from "../contract/prompt-preset-test-fixtures";
import { createBoxDecisionSettingsRoutes } from "../contract/box-decision-settings";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { applyBoxDelegateSettings, readBoxDelegateSettings, resolveBoxDelegate } from "./delegate-settings";

const chatProfile = (database: ReturnType<typeof openObservedDatabase>, displayName: string, requestUrl: string) => {
	const connections = createConnectionSettingsModule(database, { masterKey: key });
	return connections.createProfile({ expectedRevision: connections.get().revision, profile: { ...profile, displayName, requestUrl }, credential: "delegate-secret" })
		.profiles.find((saved) => saved.displayName === displayName)!.id; // @approved The profile was just created.
};

test("a delegate setting is off until chosen, ready on a usable profile, and broken with the reason libfx gives", () => {
	initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
	const database = openObservedDatabase();
	try {
		expect(resolveBoxDelegate(database, "scene")).toEqual({ kind: "off" });
		const apply = (profileId: number | null, model: string) => applyBoxDelegateSettings(database, "scene", { type: "apply", expectedRevision: readBoxDelegateSettings(database, "scene").revision, profileId, model });
		const local = chatProfile(database, "Local", "http://127.0.0.1:43131/v1/");
		expect(apply(local, " stage-1 ")).toMatchObject({ profileId: local, model: "stage-1" });
		expect(resolveBoxDelegate(database, "scene")).toMatchObject({ kind: "ready", options: { model: "stage-1" } });
		apply(chatProfile(database, "Remote", "http://192.168.1.4:8080/v1/"), "stage-1");
		expect(resolveBoxDelegate(database, "scene")).toEqual({ kind: "broken", reason: "Remote uses HTTP; an agent sends HTTP only to localhost, so use HTTPS." });
		const decision = configureDecisionModels(database, key).decisionProfileId;
		expect(() => apply(decision, "jev")).toThrow("Choose a Chat Completions connection for the delegate.");
		expect(apply(null, "")).toMatchObject({ profileId: null, model: "" });
		expect(resolveBoxDelegate(database, "scene")).toEqual({ kind: "off" });
	} finally {
		database.close();
	}
});

const plugins = mkdtempSync(join(tmpdir(), "ditzy-delegate-settings-"));
afterEach(async () => await loadBoxes([builtInBoxes]));

test("only a delegating Box has delegate settings routes", async () => {
	cpSync(join(import.meta.dir, "../../../e2e/fixtures/boxes/scene"), join(plugins, "scene"), { recursive: true });
	await loadBoxes([builtInBoxes, plugins]);
	const database = openObservedDatabase();
	try {
		const read = (box: string) => createBoxDecisionSettingsRoutes(database).handle(new Request(`http://localhost/api/boxes/${box}/delegate-settings`));
		expect(await (await read("scene")).json()).toEqual({ profileId: null, model: "", revision: 0 });
		expect((await read("mood")).status).toBe(404);
	} finally {
		database.close();
		rmSync(plugins, { recursive: true, force: true });
	}
});
