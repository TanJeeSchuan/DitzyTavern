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
	type ConnectionSettingsModule,
	type ConnectionPreset as DomainConnectionPreset,
	type ConnectionSettingsSnapshot,
} from "../connection-settings";
import { discoverModels, testConnection, type TestConnectionResult } from "../model-client";
import { withDatabase } from "../database/database";
import {
	connectionCommandBody,
	connectionProfileDraftOf,
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

// ==[HUMAN APPROVED]== Thin typed adapters over the Connection Settings seam; schemas stay in the
// shared contract and this module only maps domain outcomes to responses.
export const createConnectionSettingsRoutes = (
	database: Database | undefined,
	options: ConnectionSettingsRouteOptions = {},
) => {
	const withSettings = <T>(run: (settings: ConnectionSettingsModule) => T): T =>
		withDatabase(database, (connection) =>
			withConnectionSettings(connection, run, options),
		);

	return new Elysia()
		.get(
			"/api/connection-settings",
			() =>
				toSettingsPayload(
					withSettings((domain) => domain.get()),
				),
			{ response: connectionSettingsResponse },
		)
		.get(
			"/api/connection-settings/presets",
			() => ({
				presets: withSettings((domain) =>
					domain.listPresets().map((entry) => ({
						...entry,
						profile: toPresetProfilePayload(entry.profile),
					})),
				),
			}),
			{ response: connectionPresetsResponse },
		)
		.post(
			"/api/connection-settings/discovery",
			async ({ body, status }) => {
				const prepared = withSettings((domain) => {
					const snapshot = domain.get();
					const profile = snapshot.profiles.find((entry) => entry.id === body.profileId);
					if (profile === undefined) return null;
					return {
						profile,
						revision: snapshot.revision,
						secrets: domain.getProfileSecrets(profile.id),
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
					replaced = withSettings((domain) =>
						domain.replaceDiscoveryCatalog(
							body.profileId,
							discovered.catalog,
							prepared.revision,
							prepared.profile.modelsUrl,
						),
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
					settingsRevision: withSettings((domain) => domain.get().revision),
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
					const prepared = withSettings((domain) => {
						const profile = validateConnectionProfileDraft(body.profile);
						const secrets = body.profileId === undefined
							? null
							: domain.getProfileSecrets(body.profileId);
						return {
							profile,
							secrets: applyConnectionHeaderOperations(secrets, body.headers ?? []),
						};
					});
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
					const result = withSettings((domain) => {
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
					});
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
};

function toSettingsPayload(snapshot: ConnectionSettingsSnapshot) {
	return {
		revision: snapshot.revision,
		activeProfileId: snapshot.activeProfileId,
		profiles: snapshot.profiles.map(toProfilePayload),
	};
}

function toProfilePayload(entry: ConnectionSettingsSnapshot["profiles"][number]) {
	return {
		...connectionProfileDraftOf(entry),
		id: entry.id,
		discoveryCatalog: [...entry.discoveryCatalog],
		credentialConfigured: entry.credentialConfigured,
		headers: [...entry.headers],
	};
}

function toPresetProfilePayload(profile: DomainConnectionPreset["profile"]) {
	return connectionProfileDraftOf(profile);
}
