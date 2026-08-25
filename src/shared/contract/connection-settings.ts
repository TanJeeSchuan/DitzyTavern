import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import {
	ConnectionCredentialConfirmationError,
	ConnectionProfileNotFoundError,
	InvalidConnectionProfileError,
	StaleConnectionSettingsRevisionError,
	withConnectionSettings,
	validateConnectionProfileDraft,
} from "../../server/connection-settings";
import type { ConnectionSettingsModuleOptions } from "../../server/connection-settings";
import type { ConnectionSettingsSnapshot } from "../../server/connection-settings";
import {
	testDeepSeekConnection,
	type ModelFetch,
	type TestConnectionResult,
} from "../../server/model-client";
import { withDatabase } from "../../server/database/database";

const redactedHeader = t.Object({
	name: t.String(),
	configured: t.Boolean(),
});

const backendOptionValue = t.Union([
	t.String(),
	t.Number(),
	t.Boolean(),
	t.Null(),
]);

const profileDraft = t.Object({
	displayName: t.String(),
	apiFormat: t.Union([
		 t.Literal("chat-completions"),
		 t.Literal("responses"),
		 t.Literal("anthropic-messages"),
	]),
	requestUrl: t.String(),
	modelsUrl: t.String(),
	modelBackend: t.Union([t.Literal("automatic"), t.Literal("ai-sdk")]),
	adapter: t.Union([
		t.Literal("openai-compatible"),
		t.Literal("deepseek"),
		t.Literal("openrouter"),
	]),
	outputTokenRepresentation: t.Union([
		t.Literal("automatic"),
		t.Literal("max_tokens"),
		t.Literal("max_completion_tokens"),
		t.Literal("omit"),
	]),
	timeoutMs: t.Integer(),
	pinnedModels: t.Array(t.String()),
	backendOptions: t.Record(t.String(), backendOptionValue),
});

const profile = t.Object({
	id: t.Integer(),
	displayName: t.String(),
	apiFormat: t.String(),
	requestUrl: t.String(),
	modelsUrl: t.String(),
	modelBackend: t.String(),
	adapter: t.String(),
	outputTokenRepresentation: t.String(),
	timeoutMs: t.Integer(),
	pinnedModels: t.Array(t.String()),
	backendOptions: t.Record(t.String(), t.Unknown()),
	credentialConfigured: t.Boolean(),
	headers: t.Array(redactedHeader),
});

const settings = t.Object({
	revision: t.Integer(),
	activeProfileId: t.Nullable(t.Integer()),
	profiles: t.Array(profile),
});

const preset = t.Object({
	id: t.String(),
	label: t.String(),
	description: t.String(),
	profile: profileDraft,
});

const commandBody = t.Union([
	t.Object({
		type: t.Literal("create-profile"),
		expectedRevision: t.Integer(),
		profile: profileDraft,
		credential: t.Optional(t.Nullable(t.String())),
	}),
	t.Object({
		type: t.Literal("apply-profile"),
		expectedRevision: t.Integer(),
		profileId: t.Integer(),
		profile: profileDraft,
	}),
	t.Object({
		type: t.Literal("set-credential"),
		expectedRevision: t.Integer(),
		profileId: t.Integer(),
		credential: t.String(),
	}),
	t.Object({
		type: t.Literal("reset-credential"),
		expectedRevision: t.Integer(),
		profileId: t.Integer(),
		confirmed: t.Boolean(),
	}),
	t.Object({
		type: t.Literal("activate-profile"),
		expectedRevision: t.Integer(),
		profileId: t.Integer(),
	}),
	t.Object({
		type: t.Literal("delete-profile"),
		expectedRevision: t.Integer(),
		profileId: t.Integer(),
		replacementProfileId: t.Optional(t.Nullable(t.Integer())),
	}),
]);

const testConnectionBody = t.Object({
	profileId: t.Optional(t.Integer()),
	profile: profileDraft,
	modelId: t.String(),
	credential: t.Optional(t.Nullable(t.String())),
});

const testConnectionResult = t.Union([
	t.Object({
		outcome: t.Literal("success"),
		message: t.String(),
	}),
	t.Object({
		outcome: t.Literal("failure"),
		kind: t.Union([
			t.Literal("authentication"),
			t.Literal("endpoint"),
			t.Literal("timeout"),
			t.Literal("redirect"),
			t.Literal("malformed-response"),
			t.Literal("adapter-unavailable"),
		]),
		message: t.String(),
	}),
]);

export interface ConnectionSettingsRouteOptions extends ConnectionSettingsModuleOptions {
	readonly fetch?: ModelFetch;
	readonly testConnectionTimeoutMs?: number;
}

export const createConnectionSettingsRoutes = (
	database: Database | undefined,
	options: ConnectionSettingsRouteOptions = {},
) =>
	new Elysia()
		.get(
			"/api/connection-settings",
			() =>
				toSettingsPayload(
					withDatabase(database, (connection) =>
						withConnectionSettings(connection, (domain) => domain.get(), options),
					),
				),
			{ response: settings },
		)
		.get(
			"/api/connection-settings/presets",
			() => ({
				presets: withDatabase(database, (connection) =>
					withConnectionSettings(connection, (domain) =>
						domain.listPresets().map((entry) => ({
							...entry,
							profile: {
								...entry.profile,
								pinnedModels: [...entry.profile.pinnedModels],
								backendOptions: { ...entry.profile.backendOptions },
							},
						})), options),
				),
			}),
			{ response: t.Object({ presets: t.Array(preset) }) },
		)
		.post(
			"/api/connection-settings/test-connection",
			async ({ body, status }) => {
				try {
					const prepared = withDatabase(database, (connection) =>
						withConnectionSettings(connection, (domain) => {
							const profile = validateConnectionProfileDraft(body.profile);
							const secrets = body.profileId === undefined
								? null
								: domain.getProfileSecrets(body.profileId);
							return { profile, secrets };
						}, options),
					);
					const result = await testDeepSeekConnection(
						{
							profile: prepared.profile,
							modelId: body.modelId,
							secrets: prepared.secrets,
							credential: body.credential,
						},
						{
							fetch: options.fetch,
							timeoutMs: options.testConnectionTimeoutMs,
						},
					);
					return result satisfies TestConnectionResult;
				} catch (error) {
					if (error instanceof Error) {
						return status(422, { outcome: "invalid" as const, reason: error.message });
					}
					return status(422, {
						outcome: "invalid" as const,
						reason: "The Connection Profile draft could not be tested.",
					});
				}
			},
			{
				body: testConnectionBody,
				response: {
					200: testConnectionResult,
					422: t.Object({
						outcome: t.Literal("invalid"),
						reason: t.String(),
					}),
				},
			},
		)
		.post(
			"/api/connection-settings/commands",
			({ body, status }) => {
				try {
					const result = withDatabase(database, (connection) =>
						withConnectionSettings(connection, (domain) => {
							switch (body.type) {
								case "create-profile":
									return domain.createProfile(body);
								case "apply-profile":
									return domain.applyProfile(body);
								case "set-credential":
									return domain.setCredential(body);
								case "reset-credential":
									return domain.resetCredential(body);
								case "activate-profile":
									return domain.activateProfile(body);
								case "delete-profile":
									return domain.deleteProfile(body);
							}
						}, options),
					);
					return { outcome: "applied" as const, settings: toSettingsPayload(result) };
				} catch (error) {
					if (error instanceof StaleConnectionSettingsRevisionError) {
						return status(409, {
							outcome: "conflict" as const,
							expectedRevision: error.expectedRevision,
							actualRevision: error.actualRevision,
							currentSettings: toSettingsPayload(error.currentSettings),
						});
					}
					if (error instanceof ConnectionProfileNotFoundError) {
						return status(404, { outcome: "not-found" as const });
					}
					if (
						error instanceof InvalidConnectionProfileError ||
						error instanceof ConnectionCredentialConfirmationError
					) {
						return status(422, {
							outcome: "invalid" as const,
							reason: error.message,
						});
					}
					throw error;
				}
			},
			{
				body: commandBody,
				response: {
					200: t.Object({
						outcome: t.Literal("applied"),
						settings,
					}),
					409: t.Object({
						outcome: t.Literal("conflict"),
						expectedRevision: t.Integer(),
						actualRevision: t.Integer(),
						currentSettings: settings,
					}),
					404: t.Object({ outcome: t.Literal("not-found") }),
					422: t.Object({
						outcome: t.Literal("invalid"),
						reason: t.String(),
					}),
				},
			},
		);

export { profileDraft as connectionProfileDraftSchema };

function toSettingsPayload(snapshot: ConnectionSettingsSnapshot) {
	return {
		revision: snapshot.revision,
		activeProfileId: snapshot.activeProfileId,
		profiles: snapshot.profiles.map((entry) => ({
			id: entry.id,
			displayName: entry.displayName,
			apiFormat: entry.apiFormat,
			requestUrl: entry.requestUrl,
			modelsUrl: entry.modelsUrl,
			modelBackend: entry.modelBackend,
			adapter: entry.adapter,
			outputTokenRepresentation: entry.outputTokenRepresentation,
			timeoutMs: entry.timeoutMs,
			pinnedModels: [...entry.pinnedModels],
			backendOptions: { ...entry.backendOptions },
			credentialConfigured: entry.credentialConfigured,
			headers: [...entry.headers],
		})),
	};
}
