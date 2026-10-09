import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	connectionProfileTable,
	connectionSecretTable,
} from "../database/schema";
import { openInitializedDatabase } from "../database/database";
import {
	connectionSnapshotOf,
	createConnectionSettingsModule,
	InvalidConnectionProfileError,
} from ".";
import { StaleRevisionError } from "../revision";
import type { ConnectionProfileDraft } from "./types";

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
	pinnedModels: ["deepseek-flash", "deepseek-v4-pro"],
});

describe("Connection Settings", () => {
	let database: Database;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
	});

	afterEach(() => {
		database.close();
	});

	test("saves Profile edits and a replacement credential in one revision", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		const created = settings.createProfile({ expectedRevision: 0, profile: deepSeekDraft(), credential: "first-secret" });
		const profileId = created.profiles[0]?.id ?? 0;
		const saved = settings.applyProfile({ expectedRevision: created.revision, profileId, profile: { ...deepSeekDraft(), displayName: "Revised" }, credential: "replacement-secret" });
		expect(saved.revision).toBe(created.revision + 1);
		expect(saved.profiles[0]?.displayName).toBe("Revised");
		expect(settings.getProfileSecrets(profileId)?.credential).toBe("replacement-secret");
	});

	test("starts with no Profiles", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		expect(settings.get()).toEqual({
			revision: 0,
			profiles: [],
		});
	});

	test("constructs one safe snapshot for runtime and persisted generation identity", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		const created = settings.createProfile({ expectedRevision: 0, profile: deepSeekDraft() });
		const profile = created.profiles[0];
		if (profile === undefined) throw new Error("Connection Profile was not created.");
		const marked = settings.setTextOnlyModel({ profileId: profile.id, modelId: "text-model", textOnly: true });
		const markedProfile = marked.profiles[0];
		if (markedProfile === undefined) throw new Error("Connection Profile was not returned.");

		expect(connectionSnapshotOf(marked, markedProfile)).toEqual({
			profileId: markedProfile.id,
			settingsRevision: marked.revision,
			backend: "ai-sdk",
			adapter: markedProfile.adapter,
			apiFormat: "chat-completions",
			textOnlyModels: ["text-model"],
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
		const original = [...listedProfile.pinnedModels];
		// SAFETY: listPresets returns a mutable client-facing clone of this
		// profile; this test intentionally simulates an editor mutating it.
		(listedProfile.pinnedModels as string[]).push("temporary-edit");

		const reread = settings.listPresets().find((preset) => preset.id === "deepseek")?.profile;
		expect(reread?.pinnedModels).toEqual(original);
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

	test("applies redacted custom-header keep, replace, and remove operations atomically", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		const created = settings.createProfile({
			expectedRevision: 0,
			profile: { ...deepSeekDraft(), adapter: "openai-compatible" },
			headers: [{ name: "X-Route", operation: "replace", value: "route-secret" }],
		});
		const profileId = created.profiles[0]?.id ?? 0;
		expect(created.profiles[0]?.headers).toEqual([{ name: "X-Route", configured: true }]);
		expect(JSON.stringify(created)).not.toContain("route-secret");
		expect(settings.getProfileSecrets(profileId)).toEqual({
			credential: null,
			headers: { "X-Route": "route-secret" },
		});

		const replaced = settings.applyProfile({
			expectedRevision: created.revision,
			profileId,
			profile: { ...deepSeekDraft(), adapter: "openai-compatible" },
			headers: [
				{ name: "x-route", operation: "keep" },
				{ name: "X-Auth", operation: "replace", value: "header-secret" },
			],
		});
		expect(replaced.profiles[0]?.headers).toEqual([
			{ name: "X-Auth", configured: true },
			{ name: "X-Route", configured: true },
		]);
		expect(JSON.stringify(replaced)).not.toContain("header-secret");

		const removed = settings.applyProfile({
			expectedRevision: replaced.revision,
			profileId,
			profile: { ...deepSeekDraft(), adapter: "openai-compatible" },
			headers: [{ name: "X-Route", operation: "remove" }],
		});
		expect(removed.profiles[0]?.headers).toEqual([{ name: "X-Auth", configured: true }]);
	});

	test("rejects duplicate, malformed, and transport-owned custom header names", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		for (const name of ["X One", "Host", "content-length", "Transfer-Encoding"]) {
			expect(() => settings.createProfile({
				expectedRevision: 0,
				profile: { ...deepSeekDraft(), adapter: "openai-compatible" },
				headers: [{ name, operation: "replace", value: "secret" }],
		})).toThrow(InvalidConnectionProfileError);
		}
		expect(() => settings.createProfile({
			expectedRevision: 0,
			profile: { ...deepSeekDraft(), adapter: "openai-compatible" },
			headers: [
				{ name: "X-Route", operation: "replace", value: "one" },
				{ name: "x-route", operation: "replace", value: "two" },
			],
		})).toThrow("unique case-insensitively");
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
			expect(error).toBeInstanceOf(StaleRevisionError);
			// SAFETY: the preceding assertion narrows this caught error to the
			// typed stale-revision class exposed by the module.
			const conflict = error as StaleRevisionError;
			expect(conflict.actualRevision).toBe(1);
			expect(conflict.details).toMatchObject({ currentSettings: { profiles: [expect.objectContaining({ credentialConfigured: false })] } });
		}
	});

	test("revisioned writes bump one revision, return the post-write read, and attach conflict snapshots to stale throws", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		const created = settings.createProfile({ expectedRevision: 0, profile: deepSeekDraft() });
		const profileId = created.profiles[0]!.id;

		const pinned = settings.setPinnedModels({
			expectedRevision: created.revision,
			profileId,
			pinnedModels: ["deepseek-v4-flash"],
		});
		expect(pinned.revision).toBe(created.revision + 1);
		expect(pinned).toEqual(settings.get());

		try {
			settings.setPinnedModels({
				expectedRevision: created.revision,
				profileId,
				pinnedModels: ["deepseek-v4-pro"],
			});
			throw new Error("Expected a stale revision error.");
		} catch (error) {
			expect(error).toBeInstanceOf(StaleRevisionError);
			// SAFETY: the preceding assertion narrows this caught error to the
			// typed stale-revision class exposed by the module.
			const conflict = error as StaleRevisionError;
			expect(conflict.actualRevision).toBe(pinned.revision);
			expect(conflict.details).toMatchObject({ currentSettings: settings.get() });
		}
	});

	test("keeps every saved Profile available", () => {
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
		expect(second.profiles.map((profile) => profile.displayName)).toEqual([
			"Deep Seek",
			"Local",
		]);
	});

	test("deletes one Profile without replacing it", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		const first = settings.createProfile({ expectedRevision: 0, profile: deepSeekDraft() });
		const second = settings.createProfile({
			expectedRevision: first.revision,
			profile: { ...deepSeekDraft(), displayName: "Local" },
		});
		const deleted = settings.deleteProfile({
			expectedRevision: second.revision,
			profileId: first.profiles[0]!.id,
		});
		expect(deleted.revision).toBe(second.revision + 1);
		expect(deleted.profiles).toHaveLength(1);
		expect(deleted.profiles[0]?.displayName).toBe("Local");
	});

	test("deleting the final Profile returns to the unconfigured state", () => {
		const settings = createConnectionSettingsModule(database, { masterKey: key });
		const created = settings.createProfile({ expectedRevision: 0, profile: deepSeekDraft() });

		const deleted = settings.deleteProfile({
			expectedRevision: created.revision,
			profileId: created.profiles[0]!.id,
		});

		expect(deleted).toEqual({ revision: 2, profiles: [] });
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

});
