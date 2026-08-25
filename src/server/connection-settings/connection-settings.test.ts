import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	connectionProfileTable,
	connectionSecretTable,
	conversationControlTable,
	chatTable,
	messageTable,
	} from "../database/schema";
import { openDatabase } from "../database/database";
import {
	createConnectionSettingsModule,
	InvalidConnectionProfileError,
	StaleConnectionSettingsRevisionError,
} from ".";
import type { BackendOptions, ConnectionProfileDraft } from "./types";

const key = new Uint8Array(32).fill(7);

const deepSeekDraft = (): ConnectionProfileDraft => ({
	displayName: "  Deep   Seek  ",
	apiFormat: "chat-completions",
	requestUrl: "https://api.deepseek.com/",
	modelsUrl: "https://api.deepseek.com/models",
	modelBackend: "automatic",
	adapter: "deepseek",
	outputTokenRepresentation: "automatic",
	timeoutMs: 120000,
	pinnedModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
	backendOptions: {},
});

describe("Connection Settings", () => {
	let database: Database;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
	});

	afterEach(() => {
		database.close();
	});

	test("starts usable with no Profiles and no active connection", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		expect(settings.get()).toEqual({
			revision: 0,
			activeProfileId: null,
			profiles: [],
		});

		const db = drizzle(database);
		expect(db.select().from(chatTable).all()).toHaveLength(0);
		expect(db.select().from(messageTable).all()).toHaveLength(0);
		expect(db.select().from(conversationControlTable).all()).toHaveLength(0);
	});

	test("bundles the exact DeepSeek preset defaults", () => {
		const preset = createConnectionSettingsModule(database, { masterKey: key })
			.listPresets()
			.find((entry) => entry.id === "deepseek");
		expect(preset?.profile).toEqual({
			displayName: "DeepSeek",
			apiFormat: "chat-completions",
			requestUrl: "https://api.deepseek.com/",
			modelsUrl: "https://api.deepseek.com/models",
			modelBackend: "automatic",
			adapter: "deepseek",
			outputTokenRepresentation: "automatic",
			timeoutMs: 120000,
			pinnedModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
			backendOptions: {},
		});
	});

	test("allows the stream inactivity timeout to be disabled", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		const created = settings.createProfile({
			expectedRevision: 0,
			profile: { ...deepSeekDraft(), timeoutMs: null },
		});

		expect(created.profiles[0]?.timeoutMs).toBeNull();
	});

	test("returns preset drafts by value so profile edits cannot mutate bundled defaults", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		const listed = settings.listPresets();
		const listedProfile = listed.find((preset) => preset.id === "deepseek")?.profile;
		expect(listedProfile).toBeDefined();
		if (!listedProfile) return;
		// SAFETY: listPresets returns a mutable client-facing clone of this
		// profile; this test intentionally simulates an editor mutating it.
		(listedProfile.pinnedModels as string[]).push("temporary-edit");
		// SAFETY: BackendOptions is the closed JSON value vocabulary accepted by
		// the Connection Profile draft and this test adds a valid temporary key.
		(listedProfile.backendOptions as BackendOptions & Record<string, boolean>).temporary = true;

		const reread = settings.listPresets().find((preset) => preset.id === "deepseek")?.profile;
		expect(reread?.pinnedModels).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
		expect(reread?.backendOptions).toEqual({});
	});

	test("creates the first Profile and credential atomically, redacting the credential", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		const created = settings.createProfile({
			expectedRevision: 0,
			profile: deepSeekDraft(),
			credential: "sk-deepseek-secret",
		});
		const profile = created.profiles[0];

		expect(created.revision).toBe(1);
		expect(created.activeProfileId).toBe(profile?.id);
		expect(profile?.displayName).toBe("Deep Seek");
		expect(profile?.credentialConfigured).toBe(true);
		expect(JSON.stringify(created)).not.toContain("sk-deepseek-secret");

		const db = drizzle(database);
		const secretRow = db.select().from(connectionSecretTable).get();
		expect(secretRow).toBeDefined();
		expect(JSON.stringify(secretRow)).not.toContain("sk-deepseek-secret");
		expect(db.select().from(connectionProfileTable).all()).toHaveLength(1);
	});

	test("applies ordinary edits without touching the dedicated credential", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		const created = settings.createProfile({
			expectedRevision: 0,
			profile: deepSeekDraft(),
			credential: "first-secret",
		});
		const profileId = created.profiles[0]?.id ?? 0;
		const changed = settings.applyProfile({
			expectedRevision: created.revision,
			profileId,
			profile: {
				...deepSeekDraft(),
				displayName: "Edited DeepSeek",
				requestUrl: "http://127.0.0.1:8080/v1/",
				modelsUrl: "",
			},
		});
		expect(changed.profiles[0]?.displayName).toBe("Edited DeepSeek");
		expect(changed.profiles[0]?.requestUrl).toBe("http://127.0.0.1:8080/v1/");
		expect(changed.profiles[0]?.credentialConfigured).toBe(true);
		expect(changed.revision).toBe(2);
	});

	test("uses distinct credential update and confirmed reset actions", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		const created = settings.createProfile({
			expectedRevision: 0,
			profile: deepSeekDraft(),
			credential: "first-secret",
		});
		const profileId = created.profiles[0]?.id ?? 0;

		const updated = settings.setCredential({
			expectedRevision: created.revision,
			profileId,
			credential: "replacement-secret",
		});
		expect(updated.profiles[0]?.credentialConfigured).toBe(true);
		expect(JSON.stringify(updated)).not.toContain("replacement-secret");

		expect(() =>
			settings.resetCredential({
				expectedRevision: updated.revision,
				profileId,
				confirmed: false,
			}),
		).toThrow("explicit confirmation");

		const reset = settings.resetCredential({
			expectedRevision: updated.revision,
			profileId,
			confirmed: true,
		});
		expect(reset.profiles[0]?.credentialConfigured).toBe(false);
	});

	test("rejects malformed structural drafts before changing state", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		expect(() =>
			settings.createProfile({
				expectedRevision: 0,
				profile: { ...deepSeekDraft(), displayName: "   " },
			}),
		).toThrow(InvalidConnectionProfileError);
		expect(() =>
			settings.createProfile({
				expectedRevision: 0,
				profile: { ...deepSeekDraft(), requestUrl: "ftp://provider.test/" },
			}),
		).toThrow(InvalidConnectionProfileError);
		expect(settings.get().revision).toBe(0);
	});

	test("returns the authoritative redacted state for stale edits", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		settings.createProfile({ expectedRevision: 0, profile: deepSeekDraft() });
		try {
			settings.createProfile({
				expectedRevision: 0,
				profile: { ...deepSeekDraft(), displayName: "Stale" },
			});
			throw new Error("Expected a stale revision error.");
		} catch (error) {
			expect(error).toBeInstanceOf(StaleConnectionSettingsRevisionError);
			// SAFETY: the preceding assertion narrows this caught error to the
			// typed stale-revision class exposed by the module.
			const conflict = error as StaleConnectionSettingsRevisionError;
			expect(conflict.actualRevision).toBe(1);
			expect(conflict.currentSettings.profiles[0]?.credentialConfigured).toBe(false);
		}
	});

	test("keeps the first active Profile active while creating and applying another Profile", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		const first = settings.createProfile({
			expectedRevision: 0,
			profile: deepSeekDraft(),
		});
		const second = settings.createProfile({
			expectedRevision: first.revision,
			profile: { ...deepSeekDraft(), displayName: "Local", requestUrl: "http://127.0.0.1:8080/v1/" },
		});

		expect(second.revision).toBe(2);
		expect(second.activeProfileId).toBe(first.activeProfileId);
		expect(second.profiles.map((profile) => profile.displayName)).toEqual([
			"Deep Seek",
			"Local",
		]);
	});

	test("activates another Profile with one atomic revision advance", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		const first = settings.createProfile({ expectedRevision: 0, profile: deepSeekDraft() });
		const second = settings.createProfile({
			expectedRevision: first.revision,
			profile: { ...deepSeekDraft(), displayName: "Local" },
		});
		const secondId = second.profiles.find((profile) => profile.displayName === "Local")?.id ?? 0;

		const activated = settings.activateProfile({
			expectedRevision: second.revision,
			profileId: secondId,
		});

		expect(activated.revision).toBe(3);
		expect(activated.activeProfileId).toBe(secondId);
		expect(activated.profiles).toHaveLength(2);
	});

	test("requires a replacement before deleting the active Profile when another exists", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		const first = settings.createProfile({ expectedRevision: 0, profile: deepSeekDraft() });
		const second = settings.createProfile({
			expectedRevision: first.revision,
			profile: { ...deepSeekDraft(), displayName: "Local" },
		});
		const secondId = second.profiles.find((profile) => profile.displayName === "Local")?.id ?? 0;

		expect(() => settings.deleteProfile({
			expectedRevision: second.revision,
			profileId: first.activeProfileId ?? 0,
		})).toThrow("requires a replacement");
		expect(settings.get().revision).toBe(second.revision);

		const deleted = settings.deleteProfile({
			expectedRevision: second.revision,
			profileId: first.activeProfileId ?? 0,
			replacementProfileId: secondId,
		});
		expect(deleted.revision).toBe(second.revision + 1);
		expect(deleted.activeProfileId).toBe(secondId);
		expect(deleted.profiles).toHaveLength(1);
	});

	test("deleting the final Profile returns to the unconfigured state", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		const created = settings.createProfile({ expectedRevision: 0, profile: deepSeekDraft() });

		const deleted = settings.deleteProfile({
			expectedRevision: created.revision,
			profileId: created.activeProfileId ?? 0,
		});

		expect(deleted).toEqual({ revision: 2, activeProfileId: null, profiles: [] });
	});

	test("rejects case-insensitive duplicate names without changing the aggregate", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		const created = settings.createProfile({ expectedRevision: 0, profile: deepSeekDraft() });

		expect(() => settings.createProfile({
			expectedRevision: created.revision,
			profile: { ...deepSeekDraft(), displayName: " deep seek " },
		})).toThrow("already exists");
		expect(settings.get().revision).toBe(created.revision);
		expect(settings.get().profiles).toHaveLength(1);
	});

	test("returns authoritative state when activation is stale", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		const first = settings.createProfile({ expectedRevision: 0, profile: deepSeekDraft() });
		const second = settings.createProfile({
			expectedRevision: first.revision,
			profile: { ...deepSeekDraft(), displayName: "Local" },
		});
		const secondId = second.profiles.find((profile) => profile.displayName === "Local")?.id ?? 0;

		settings.activateProfile({ expectedRevision: second.revision, profileId: secondId });
		expect(() => settings.activateProfile({ expectedRevision: second.revision, profileId: first.activeProfileId ?? 0 }))
			.toThrow(StaleConnectionSettingsRevisionError);
	});
});
