import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../../server/database/database";
import { createConnectionSettingsRoutes } from "./connection-settings";
import type { ConnectionProfileDraft } from "../../server/connection-settings";
import type { ModelFetch } from "../../server/model-client";

const key = new Uint8Array(32).fill(11);

const deepSeekProfile = {
	displayName: "DeepSeek",
	apiFormat: "chat-completions" as const,
	requestUrl: "https://api.deepseek.com/",
	modelsUrl: "https://api.deepseek.com/models",
	modelBackend: "automatic" as const,
	adapter: "deepseek" as const,
	outputTokenRepresentation: "automatic" as const,
	timeoutMs: 120000,
	pinnedModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
};

type ConnectionCommandPayload =
	| {
		type: "create-profile";
		expectedRevision: number;
		profile: ConnectionProfileDraft;
		credential?: string | null;
	}
	| {
		type: "apply-profile";
		expectedRevision: number;
		profileId: number;
		profile: ConnectionProfileDraft;
	}
	| {
		type: "set-credential";
		expectedRevision: number;
		profileId: number;
		credential: string;
	}
	| {
		type: "reset-credential";
		expectedRevision: number;
		profileId: number;
		confirmed: boolean;
	}
	| {
		type: "activate-profile";
		expectedRevision: number;
		profileId: number;
	}
	| {
		type: "delete-profile";
		expectedRevision: number;
		profileId: number;
		replacementProfileId?: number | null;
	};

describe("Connection Settings transport adapter", () => {
	let database: Database;
	let app: ReturnType<typeof createConnectionSettingsRoutes>;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
		app = createConnectionSettingsRoutes(database, { masterKey: key });
	});

	afterEach(() => {
		database.close();
	});

	const get = (path: string) => app.handle(new Request(`http://localhost${path}`));

	const post = (body: ConnectionCommandPayload) =>
		app.handle(
			new Request("http://localhost/api/connection-settings/commands", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);

	const discover = (profileId: number, fetch: ModelFetch) =>
		createConnectionSettingsRoutes(database, { masterKey: key, fetch }).handle(
			new Request("http://localhost/api/connection-settings/discovery", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ profileId }),
			}),
		);

	test("reports the zero-Profile unconfigured outcome and exposes Presets", async () => {
		const settings = await get("/api/connection-settings");
		expect(settings.status).toBe(200);
		expect(await settings.json()).toEqual({
			revision: 0,
			activeProfileId: null,
			profiles: [],
		});

		const presets = await get("/api/connection-settings/presets");
		expect(presets.status).toBe(200);
		const body = await presets.json();
		expect(body.presets.map((entry: { id: string }) => entry.id)).toEqual([
			"deepseek",
			"openrouter",
			"generic-openai-compatible",
		]);
	});

	test("creates the first Profile with a redacted credential through the contract", async () => {
		const response = await post({
			type: "create-profile",
			expectedRevision: 0,
			profile: deepSeekProfile,
			credential: "secret-value-never-returned",
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.outcome).toBe("applied");
		expect(body.settings.activeProfileId).toBe(body.settings.profiles[0].id);
		expect(body.settings.profiles[0].credentialConfigured).toBe(true);
		expect(JSON.stringify(body)).not.toContain("secret-value-never-returned");

		const reread = await get("/api/connection-settings");
		expect(JSON.stringify(await reread.json())).not.toContain(
			"secret-value-never-returned",
		);
	});

	test("maps structural errors and keeps the complete draft local to the caller", async () => {
		const response = await post({
			type: "create-profile",
			expectedRevision: 0,
			profile: { ...deepSeekProfile, displayName: "   " },
		});
		expect(response.status).toBe(422);
		const body = await response.json();
		expect(body.outcome).toBe("invalid");
		expect(body.reason).toContain("display name");

		const settings = await get("/api/connection-settings");
		expect((await settings.json()).revision).toBe(0);
	});

	test("rejects arbitrary Backend Options instead of persisting or echoing them", async () => {
		const response = await post({
			type: "create-profile",
			expectedRevision: 0,
			profile: { ...deepSeekProfile, backendOptions: { experimental: true } },
		});

		expect(response.status).toBe(422);
		expect((await response.json()).outcome).toBe("invalid");
		const settings = await get("/api/connection-settings");
		expect((await settings.json()).revision).toBe(0);
	});

	test("refreshes and persists a normalized catalog without changing revision or pins", async () => {
		const created = await post({
			type: "create-profile",
			expectedRevision: 0,
			profile: deepSeekProfile,
			credential: "discovery-secret",
		});
		const createdBody = await created.json();
		const profileId = createdBody.settings.profiles[0].id;
		const revision = createdBody.settings.revision;
		const response = await discover(profileId, async (_input, init) => {
			expect(init?.method).toBe("GET");
			expect(init?.redirect).toBe("error");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer discovery-secret");
			return new Response(JSON.stringify({ data: [{ id: " zeta " }, { id: "Alpha" }, { id: "alpha" }, { id: "" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.outcome).toBe("success");
		expect(body.settingsRevision).toBe(revision);
		expect(body.profile.discoveryCatalog).toEqual(["Alpha", "alpha", "zeta"]);
		expect(body.profile.pinnedModels).toEqual(deepSeekProfile.pinnedModels);

		const reread = await get("/api/connection-settings");
		const settings = await reread.json();
		expect(settings.revision).toBe(revision);
		expect(settings.profiles[0].discoveryCatalog).toEqual(["Alpha", "alpha", "zeta"]);
	});

	test("preserves a failed catalog and clears it only when Models URL changes", async () => {
		const created = await post({
			type: "create-profile",
			expectedRevision: 0,
			profile: deepSeekProfile,
		});
		const createdBody = await created.json();
		const profileId = createdBody.settings.profiles[0].id;
		const successful = await discover(profileId, async () =>
			new Response(JSON.stringify({ data: [{ id: "kept-model" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		expect(successful.status).toBe(200);
		const afterSuccess = await successful.json();

		const failed = await discover(profileId, async () =>
			new Response(JSON.stringify({ message: "temporary outage" }), {
				status: 503,
				headers: { "content-type": "application/json" },
			}),
		);
		expect(failed.status).toBe(200);
		expect(await failed.json()).toMatchObject({ outcome: "failure", kind: "endpoint" });
		const afterFailure = await get("/api/connection-settings");
		expect((await afterFailure.json()).profiles[0].discoveryCatalog).toEqual(["kept-model"]);

		const applied = await post({
			type: "apply-profile",
			expectedRevision: afterSuccess.settingsRevision,
			profileId,
			profile: { ...deepSeekProfile, modelsUrl: "http://127.0.0.1:43127/other-models" },
		});
		expect(applied.status).toBe(200);
		const afterApply = await applied.json();
		expect(afterApply.settings.profiles[0].discoveryCatalog).toEqual([]);
		expect(afterApply.settings.profiles[0].pinnedModels).toEqual(deepSeekProfile.pinnedModels);
	});

	test("activates and deletes Profiles through revisioned commands", async () => {
		const firstResponse = await post({
			type: "create-profile",
			expectedRevision: 0,
			profile: deepSeekProfile,
		});
		const firstBody = await firstResponse.json();
		const secondResponse = await post({
			type: "create-profile",
			expectedRevision: firstBody.settings.revision,
			profile: { ...deepSeekProfile, displayName: "Local" },
		});
		const secondBody = await secondResponse.json();
		const firstId = firstBody.settings.profiles[0].id;
		const secondId = secondBody.settings.profiles[1].id;

		const activated = await post({
			type: "activate-profile",
			expectedRevision: secondBody.settings.revision,
			profileId: secondId,
		});
		expect(activated.status).toBe(200);
		expect((await activated.json()).settings.activeProfileId).toBe(secondId);

		const missingReplacement = await post({
			type: "delete-profile",
			expectedRevision: secondBody.settings.revision + 1,
			profileId: secondId,
		});
		expect(missingReplacement.status).toBe(422);
		expect((await missingReplacement.json()).reason).toContain("requires a replacement");

		const deleted = await post({
			type: "delete-profile",
			expectedRevision: secondBody.settings.revision + 1,
			profileId: secondId,
			replacementProfileId: firstId,
		});
		expect(deleted.status).toBe(200);
		expect((await deleted.json()).settings).toMatchObject({
			activeProfileId: firstId,
			profiles: [{ id: firstId }],
		});
	});

	test("returns a typed authoritative conflict for stale activation", async () => {
		const firstResponse = await post({
			type: "create-profile",
			expectedRevision: 0,
			profile: deepSeekProfile,
		});
		const firstBody = await firstResponse.json();
		const secondResponse = await post({
			type: "create-profile",
			expectedRevision: firstBody.settings.revision,
			profile: { ...deepSeekProfile, displayName: "Local" },
		});
		const secondBody = await secondResponse.json();
		const secondId = secondBody.settings.profiles[1].id;

		const activated = await post({
			type: "activate-profile",
			expectedRevision: secondBody.settings.revision,
			profileId: secondId,
		});
		expect(activated.status).toBe(200);

		const stale = await post({
			type: "activate-profile",
			expectedRevision: secondBody.settings.revision,
			profileId: secondBody.settings.profiles[0].id,
		});
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({
			outcome: "conflict",
			expectedRevision: secondBody.settings.revision,
			actualRevision: secondBody.settings.revision + 1,
			currentSettings: { activeProfileId: secondId },
		});
	});

	test("tests the unsaved draft with kept or replacement credentials without durable side effects", async () => {
		const createdResponse = await post({
			type: "create-profile",
			expectedRevision: 0,
			profile: deepSeekProfile,
			credential: "existing-secret",
		});
		const createdBody = await createdResponse.json();
		const profileId = createdBody.settings.profiles[0].id;
		const before = await get("/api/connection-settings");
		const beforeBody = await before.json();
		type CapturedRequestBody = { model: string; max_tokens: number; messages: Array<{ role: string; content: string }> };
		const requests: Array<{ url: string; authorization: string | null; body: CapturedRequestBody }> = [];
		const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			requests.push({
				url: String(input),
				authorization: headers.get("authorization"),
				// SAFETY: the fake fetch receives the AI SDK Chat Completions body
				// and the test only reads the three invariant fields below.
				body: JSON.parse(String(init?.body)) as CapturedRequestBody,
			});
			return new Response(JSON.stringify({
				id: "test",
				object: "chat.completion",
				created: 1,
				model: "deepseek-chat",
				choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			}), { status: 200, headers: { "content-type": "application/json" } });
		};
		const testApp = createConnectionSettingsRoutes(database, { masterKey: key, fetch: fakeFetch });
		type TestDraftRequestBody = {
			profileId: number;
			profile: typeof deepSeekProfile;
			modelId: string;
		};
		const test = () => {
			const body: TestDraftRequestBody = {
				profileId,
				profile: { ...deepSeekProfile, requestUrl: "http://127.0.0.1:43127/v1/?tenant=test" },
				modelId: "deepseek-chat",
			};
			return testApp.handle(new Request("http://localhost/api/connection-settings/test-connection", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}));
		};

		const kept = await test();
		expect(kept.status).toBe(200);
		expect((await kept.json()).outcome).toBe("success");
		expect(requests[0]?.url).toBe("http://127.0.0.1:43127/v1/chat/completions?tenant=test");
		expect(requests[0]?.authorization).toBe("Bearer existing-secret");
		expect(requests[0]?.body.model).toBe("deepseek-chat");

		const update = await post({
			type: "set-credential",
			expectedRevision: beforeBody.revision,
			profileId,
			credential: "replacement-secret",
		});
		expect(update.status).toBe(200);
		const replacement = await test();
		expect(replacement.status).toBe(200);
		expect(requests[1]?.authorization).toBe("Bearer replacement-secret");
		const after = await get("/api/connection-settings");
		const afterBody = await after.json();
		expect(afterBody.profiles[0]?.credential).toBeUndefined();
	});

	test("tests a generic exact endpoint with redacted custom-header replacement drafts", async () => {
		const fakeFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe("Custom auth never returned");
			expect(headers.get("x-route")).toBe("route secret never returned");
			return new Response(JSON.stringify({
				choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
			}), { status: 200, headers: { "content-type": "application/json" } });
		};
		const testApp = createConnectionSettingsRoutes(database, { masterKey: key, fetch: fakeFetch });
		const response = await testApp.handle(new Request("http://localhost/api/connection-settings/test-connection", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				profile: {
					...deepSeekProfile,
					displayName: "Local",
					adapter: "openai-compatible",
					requestUrl: "http://127.0.0.1:43127/generate",
				},
				modelId: "local-model",
				headers: [
					{ name: "Authorization", operation: "replace", value: "Custom auth never returned" },
					{ name: "X-Route", operation: "replace", value: "route secret never returned" },
				],
			}),
		}));
		expect(response.status).toBe(200);
		expect(JSON.stringify(await response.json())).not.toContain("never returned");
	});
});
