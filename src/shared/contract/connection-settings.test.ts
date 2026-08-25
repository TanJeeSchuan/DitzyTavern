import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../../server/database/database";
import { createConnectionSettingsRoutes } from "./connection-settings";
import type { ConnectionProfileDraft } from "../../server/connection-settings";

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
	backendOptions: {},
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
});
