import type { Database } from "bun:sqlite";
import { Elysia, t, type Static } from "elysia";
import {
	ConnectionCredentialConfirmationError,
	ConnectionProfileNotFoundError,
	InvalidConnectionProfileError,
	applyConnectionHeaderOperations,
	StaleConnectionSettingsRevisionError,
	withConnectionSettings,
	validateConnectionProfileDraft,
} from "../../server/connection-settings";
import type { ConnectionSettingsModuleOptions } from "../../server/connection-settings";
import type {
	ConnectionPreset as DomainConnectionPreset,
	ConnectionSettingsSnapshot,
} from "../../server/connection-settings";
import {
	discoverModels,
	testConnection,
	type ModelFetch,
	type TestConnectionResult,
} from "../../server/model-client";
import { withDatabase } from "../../server/database/database";

const redactedHeader = t.Object({
	name: t.String(),
	configured: t.Boolean(),
});

const headerOperation = t.Union([
	t.Object({ name: t.String(), operation: t.Literal("keep") }),
	t.Object({ name: t.String(), operation: t.Literal("replace"), value: t.String() }),
	t.Object({ name: t.String(), operation: t.Literal("remove") }),
]);

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
	timeoutMs: t.Nullable(t.Integer()),
	pinnedModels: t.Array(t.String()),
	// Legacy request payloads may still carry this field so the domain can reject
	// non-empty values explicitly; it is omitted from every exported client type.
	backendOptions: t.Optional(t.Record(t.String(), backendOptionValue)),
}, { additionalProperties: false });

const profile = t.Object({
	id: t.Integer(),
	displayName: t.String(),
	apiFormat: t.Union([
		t.Literal("chat-completions"),
		t.Literal("responses"),
		t.Literal("anthropic-messages"),
	]),
	requestUrl: t.String(),
	modelsUrl: t.String(),
	modelBackend: t.Union([t.Literal("automatic"), t.Literal("ai-sdk")]),
	adapter: t.Union([t.Literal("openai-compatible"), t.Literal("deepseek"), t.Literal("openrouter")]),
	outputTokenRepresentation: t.Union([t.Literal("automatic"), t.Literal("max_tokens"), t.Literal("max_completion_tokens"), t.Literal("omit")]),
	timeoutMs: t.Nullable(t.Integer()),
	pinnedModels: t.Array(t.String()),
	discoveryCatalog: t.Array(t.String()),
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
		headers: t.Optional(t.Array(headerOperation)),
	}),
	t.Object({
		type: t.Literal("apply-profile"),
		expectedRevision: t.Integer(),
		profileId: t.Integer(),
		profile: profileDraft,
		headers: t.Optional(t.Array(headerOperation)),
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
	t.Object({
		type: t.Literal("set-pinned-models"),
		expectedRevision: t.Integer(),
		profileId: t.Integer(),
		pinnedModels: t.Array(t.String()),
	}),
]);

const testConnectionBody = t.Object({
	profileId: t.Optional(t.Integer()),
	profile: profileDraft,
	modelId: t.String(),
	headers: t.Optional(t.Array(headerOperation)),
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

const discoveryFailureKind = t.Union([
	t.Literal("authentication"),
	t.Literal("endpoint"),
	t.Literal("timeout"),
	t.Literal("redirect"),
	t.Literal("malformed-response"),
]);

const discoveryResult = t.Union([
	t.Object({
		outcome: t.Literal("success"),
		profile,
		settingsRevision: t.Integer(),
	}),
	t.Object({
		outcome: t.Literal("failure"),
		kind: discoveryFailureKind,
		message: t.String(),
	}),
	t.Object({
		outcome: t.Literal("conflict"),
		expectedRevision: t.Integer(),
		actualRevision: t.Integer(),
		currentSettings: settings,
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
						profile: toPresetProfilePayload(entry.profile),
						})), options),
				),
			}),
			{ response: t.Object({ presets: t.Array(preset) }) },
		)
		.post(
			"/api/connection-settings/discovery",
			async ({ body, status }) => {
				const prepared = withDatabase(database, (connection) => {
					const snapshot = withConnectionSettings(connection, (domain) => domain.get(), options);
					const profile = snapshot.profiles.find((entry) => entry.id === body.profileId);
					if (profile === undefined) return null;
					return {
						profile,
						revision: snapshot.revision,
						secrets: withConnectionSettings(connection, (domain) => domain.getProfileSecrets(profile.id), options),
					};
				});
				if (prepared === null) return status(404, { outcome: "not-found" as const });
				if (prepared.profile.modelsUrl.trim().length === 0) {
					return status(422, {
						outcome: "invalid" as const,
						reason: "Refresh requires an exact Models URL.",
					});
				}
				const discovered = await discoverModels(
					{ profile: prepared.profile, secrets: prepared.secrets },
					{ fetch: options.fetch },
			);
			if (discovered.outcome === "failure") return discovered;
			let replaced: ConnectionSettingsSnapshot["profiles"][number];
			try {
				replaced = withDatabase(database, (connection) =>
					withConnectionSettings(connection, (domain) =>
						domain.replaceDiscoveryCatalog(
							body.profileId,
							discovered.catalog,
							prepared.revision,
							prepared.profile.modelsUrl,
						), options),
				);
			} catch (error) {
				if (error instanceof ConnectionProfileNotFoundError) {
					return status(404, { outcome: "not-found" as const });
				}
				if (error instanceof StaleConnectionSettingsRevisionError) {
					return status(409, {
						outcome: "conflict" as const,
						expectedRevision: error.expectedRevision,
						actualRevision: error.actualRevision,
						currentSettings: toSettingsPayload(error.currentSettings),
					});
				}
				throw error;
			}
			return {
					outcome: "success" as const,
					profile: toProfilePayload(replaced),
					settingsRevision: withDatabase(database, (connection) =>
						withConnectionSettings(connection, (domain) => domain.get().revision, options)),
				};
			},
			{
				body: t.Object({ profileId: t.Integer() }),
				response: {
					200: discoveryResult,
					404: t.Object({ outcome: t.Literal("not-found") }),
					422: t.Object({ outcome: t.Literal("invalid"), reason: t.String() }),
					409: t.Object({
						outcome: t.Literal("conflict"),
						expectedRevision: t.Integer(),
						actualRevision: t.Integer(),
						currentSettings: settings,
					}),
				},
			},
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
							return {
								profile,
								secrets: applyConnectionHeaderOperations(secrets, body.headers ?? []),
							};
						}, options),
					);
					const result = await testConnection(
						{
							profile: prepared.profile,
							modelId: body.modelId,
							secrets: prepared.secrets,
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
								case "set-pinned-models":
									return domain.setPinnedModels(body);
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

export type ConnectionProfileDraftPayload = Omit<Static<typeof profileDraft>, "backendOptions">;
export type ConnectionProfilePayload = Static<typeof profile>;
export type ConnectionSettingsPayload = Static<typeof settings>;
export type ConnectionPresetPayload = Static<typeof preset>;
export type ConnectionHeaderOperationPayload = Static<typeof headerOperation>;
export type ConnectionTestResultPayload = Static<typeof testConnectionResult>;
export type ConnectionDiscoveryResultPayload = Static<typeof discoveryResult>;

export type ConnectionSettingsCommandPayload =
	| {
			type: "create-profile";
			expectedRevision: number;
			profile: ConnectionProfileDraftPayload;
			credential?: string | null;
			headers?: ConnectionHeaderOperationPayload[];
	  }
	| {
			type: "apply-profile";
			expectedRevision: number;
			profileId: number;
			profile: ConnectionProfileDraftPayload;
			headers?: ConnectionHeaderOperationPayload[];
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
	  }
	| {
			type: "set-pinned-models";
			expectedRevision: number;
			profileId: number;
			pinnedModels: string[];
	  };

export type ConnectionTestDraftPayload = {
	profileId?: number;
	profile: ConnectionProfileDraftPayload;
	modelId: string;
	headers?: ConnectionHeaderOperationPayload[];
};

export type ConnectionSettingsCommandResultPayload =
	| { outcome: "applied"; settings: ConnectionSettingsPayload }
	| {
			outcome: "conflict";
			expectedRevision: number;
			actualRevision: number;
			currentSettings: ConnectionSettingsPayload;
	  }
	| { outcome: "invalid"; reason: string }
	| { outcome: "not-found" };

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
			discoveryCatalog: [...entry.discoveryCatalog],
			credentialConfigured: entry.credentialConfigured,
			headers: [...entry.headers],
		})),
	};
}

function toProfilePayload(entry: ConnectionSettingsSnapshot["profiles"][number]) {
	return {
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
		discoveryCatalog: [...entry.discoveryCatalog],
		credentialConfigured: entry.credentialConfigured,
		headers: [...entry.headers],
	};
}

function toPresetProfilePayload(profile: DomainConnectionPreset["profile"]) {
	return {
		displayName: profile.displayName,
		apiFormat: profile.apiFormat,
		requestUrl: profile.requestUrl,
		modelsUrl: profile.modelsUrl,
		modelBackend: profile.modelBackend,
		adapter: profile.adapter,
		outputTokenRepresentation: profile.outputTokenRepresentation,
		timeoutMs: profile.timeoutMs,
		pinnedModels: [...profile.pinnedModels],
	};
}
