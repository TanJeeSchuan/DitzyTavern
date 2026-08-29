import type { Database } from "bun:sqlite";
import { Elysia, status } from "elysia";
import {
	ConnectionCredentialConfirmationError,
	ConnectionProfileNotFoundError,
	InvalidConnectionProfileError,
	applyConnectionHeaderOperations,
	StaleConnectionSettingsRevisionError,
	withConnectionSettings,
	validateConnectionProfileDraft,
	type ConnectionSettingsModuleOptions,
	type ConnectionPreset as DomainConnectionPreset,
	type ConnectionSettingsSnapshot,
} from "../connection-settings";
import { discoverModels, testConnection, type TestConnectionResult } from "../model-client";
import { withDatabase } from "../database/database";
import {
	connectionCommandBody,
	connectionDiscoveryBody,
	connectionDiscoveryResponse,
	connectionInvalidResponse,
	connectionNotFoundResponse,
	connectionPresetsResponse,
	connectionSettingsApplied,
	connectionSettingsConflict,
	connectionSettingsResponse,
	connectionTestBody,
	connectionTestResponse,
} from "../../shared/contract/connection-settings";

export interface ConnectionSettingsRouteOptions extends ConnectionSettingsModuleOptions {
	readonly fetch?: import("../model-client").ModelFetch;
	readonly testConnectionTimeoutMs?: number;
}

const staleSettingsResponse = (error: StaleConnectionSettingsRevisionError) =>
	status(409, {
		outcome: "conflict" as const,
		expectedRevision: error.expectedRevision,
		actualRevision: error.actualRevision,
		currentSettings: toSettingsPayload(error.currentSettings),
	});

// Thin typed adapters over the Connection Settings seam; schemas stay in the
// shared contract and this module only maps domain outcomes to responses.
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
			{ response: connectionSettingsResponse },
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
			{ response: connectionPresetsResponse },
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
						return staleSettingsResponse(error);
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
					body: connectionDiscoveryBody,
					response: {
						200: connectionDiscoveryResponse,
						404: connectionNotFoundResponse,
						422: connectionInvalidResponse,
						409: connectionSettingsConflict,
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
				body: connectionTestBody,
				response: {
					200: connectionTestResponse,
					422: connectionInvalidResponse,
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
						return staleSettingsResponse(error);
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
				body: connectionCommandBody,
				response: {
					200: connectionSettingsApplied,
					409: connectionSettingsConflict,
					404: connectionNotFoundResponse,
					422: connectionInvalidResponse,
				},
			},
		);

function toSettingsPayload(snapshot: ConnectionSettingsSnapshot) {
	return {
		revision: snapshot.revision,
		activeProfileId: snapshot.activeProfileId,
		profiles: snapshot.profiles.map(toProfilePayload),
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
