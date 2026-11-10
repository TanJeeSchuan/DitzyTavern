import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { builtInBoxes, loadBoxes } from "./registry";
import { createConnectionSettingsModule } from "../connection-settings";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { configureDecisionModels } from "../contract/decision-model-test-fixtures";
import { key, profile } from "../contract/prompt-preset-test-fixtures";
import { createBoxDecisionSettingsRoutes } from "../contract/box-decision-settings";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { DEFAULT_BOX_DELEGATE } from "../../shared/contract/box";
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

test("an unset Box inherits the default, its own selection wins, and a broken default keeps its reason", () => {
	initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
	const database = openObservedDatabase();
	try {
		const local = chatProfile(database, "Local", "http://127.0.0.1:43131/v1/");
		const apply = (box: string, profileId: number | null, model: string) => applyBoxDelegateSettings(database, box, { type: "apply", expectedRevision: readBoxDelegateSettings(database, box).revision, profileId, model });
		apply(DEFAULT_BOX_DELEGATE, local, "default-model");
		expect(resolveBoxDelegate(database, "scene")).toMatchObject({ kind: "ready", options: { model: "default-model" } });
		expect(readBoxDelegateSettings(database, "scene")).toEqual({ profileId: null, model: "", revision: 0 });
		apply("scene", local, "own-model");
		expect(resolveBoxDelegate(database, "scene")).toMatchObject({ kind: "ready", options: { model: "own-model" } });
		apply(DEFAULT_BOX_DELEGATE, chatProfile(database, "Remote default", "http://192.168.1.4:8080/v1/"), "broken-model");
		expect(resolveBoxDelegate(database, "scene")).toMatchObject({ kind: "ready", options: { model: "own-model" } });
		apply("scene", null, "");
		expect(resolveBoxDelegate(database, "scene")).toEqual({ kind: "broken", reason: "Remote default uses HTTP; an agent sends HTTP only to localhost, so use HTTPS." });
		apply(DEFAULT_BOX_DELEGATE, null, "");
		expect(resolveBoxDelegate(database, "scene")).toEqual({ kind: "off" });
	} finally {
		database.close();
	}
});

test("the host default uses the settings route's apply and conflict flow without a delegating Box installed", async () => {
	initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
	const database = openObservedDatabase();
	try {
		const profileId = chatProfile(database, "Local", "http://127.0.0.1:43131/v1/");
		const routes = createBoxDecisionSettingsRoutes(database);
		const url = `http://localhost/api/boxes/${DEFAULT_BOX_DELEGATE}/delegate-settings`;
		const body = { type: "apply", expectedRevision: 0, profileId, model: "default-model" };
		const apply = () => routes.handle(new Request(`${url}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
		const applied = await apply();
		expect(applied.status).toBe(200);
		const saved = await applied.json();
		expect(saved).toMatchObject({ outcome: "applied", settings: { profileId, model: "default-model" } });
		expect(await (await routes.handle(new Request(url))).json()).toEqual(saved.settings);
		const conflict = await apply();
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({ outcome: "conflict", currentSettings: saved.settings });
	} finally {
		database.close();
	}
});

afterEach(async () => await loadBoxes([builtInBoxes]));

test("only a delegating Box has delegate settings routes", async () => {
	const scratch = join(import.meta.dir, "../../../.scratch");
	mkdirSync(scratch, { recursive: true });
	const plugins = mkdtempSync(join(scratch, "delegate-settings-"));
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
