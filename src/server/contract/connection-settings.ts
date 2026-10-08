import { presentDomainError } from "./domain-error";
import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import {
	applyConnectionHeaderOperations,
	createConnectionSettingsModule,
	validateConnectionProfileDraft,
	type ConnectionSettingsModuleOptions,
	type ConnectionPreset as DomainConnectionPreset,
	type ConnectionSettingsSnapshot,
} from "../connection-settings";
import { discoverModels, testConnection, type TestConnectionResult } from "../model-client";

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
	connectionTextOnlyBody,
	connectionTestResponse,
} from "../../shared/contract/connection-settings";

const commandResponse = {
	200: connectionSettingsApplied,
	409: connectionSettingsConflict,
	404: connectionNotFoundResponse,
	422: connectionInvalidResponse,
};

const testConnectionResponse = {
	200: connectionTestResponse,
	422: connectionInvalidResponse,
};

const textOnlyModelResponse = {
	200: connectionSettingsApplied,
	404: connectionNotFoundResponse,
	422: connectionInvalidResponse,
};

const discoveryResponse = {
	200: connectionDiscoveryResponse,
	404: connectionNotFoundResponse,
	422: connectionInvalidResponse,
	409: connectionSettingsConflict,
};

export interface ConnectionSettingsRouteOptions extends ConnectionSettingsModuleOptions {
	readonly fetch?: import("../model-client").ModelFetch;
	readonly testConnectionTimeoutMs?: number;
}

// @approved
//  Thin typed adapters over the Connection Settings seam; schemas stay in the
// shared contract and this module only maps domain outcomes to responses.
export const createConnectionSettingsRoutes = (
	database: Database,
	options: ConnectionSettingsRouteOptions = {},
) => {
	const settings = createConnectionSettingsModule(database, options);

	return new Elysia()
		.get(
			"/api/connection-settings",
			() => toSettingsPayload(settings.get()),
			{ response: connectionSettingsResponse },
		)
		.get(
			"/api/connection-settings/presets",
			() => ({
				presets: settings.listPresets().map((entry) => ({
					...entry,
					profile: toPresetProfilePayload(entry.profile),
				})),
			}),
			{ response: connectionPresetsResponse },
		)
		.post(
			"/api/connection-settings/discovery",
			async ({ body, status }) => {
				const snapshot = settings.get();
				const profile = snapshot.profiles.find((entry) => entry.id === body.profileId);
				if (profile === undefined) return status(404, { outcome: "not-found" as const });
				if (profile.modelsUrl.trim().length === 0) {
					return status(422, {
						outcome: "invalid" as const,
						reason: "Refresh requires an exact Models URL.",
					});
				}
				const discovered = await discoverModels(
					{ profile, secrets: settings.getProfileSecrets(profile.id) },
					{ fetch: options.fetch },
				);
				if (discovered.outcome === "failure") return discovered;
				let replaced: ConnectionSettingsSnapshot["profiles"][number];
				try {
					replaced = settings.replaceDiscoveryCatalog(
						body.profileId,
						discovered.catalog,
						snapshot.revision,
						profile.modelsUrl,
					);
				} catch (error) {
					return presentDomainError(error, discoveryResponse);
				}
				return {
					outcome: "success" as const,
					profile: toProfilePayload(replaced),
					settingsRevision: settings.get().revision,
				};
			},
			{
				body: connectionDiscoveryBody,
				response: discoveryResponse,
			},
		)
		.post(
			"/api/connection-settings/text-only-model",
			({ body }) => {
				try {
					return { outcome: "applied" as const, settings: toSettingsPayload(settings.setTextOnlyModel(body)) };
				} catch (error) {
					return presentDomainError(error, textOnlyModelResponse);
				}
			},
			{
				body: connectionTextOnlyBody,
				response: textOnlyModelResponse,
			},
		)
		.post(
			"/api/connection-settings/test-connection",
			async ({ body }) => {
				try {
					const profile = validateConnectionProfileDraft(body.profile);
					const savedProfile = body.profileId === undefined ? undefined : settings.get().profiles.find((entry) => entry.id === body.profileId);
					const secrets = savedProfile?.requestUrl === profile.requestUrl ? settings.getProfileSecrets(savedProfile.id) : null;
					const result = await testConnection(
						{
							profile,
							modelId: body.modelId,
							secrets: applyConnectionHeaderOperations(secrets, body.headers ?? []),
						},
						{
							fetch: options.fetch,
							timeoutMs: options.testConnectionTimeoutMs,
						},
					);
					return result satisfies TestConnectionResult;
				} catch (error) {
					return presentDomainError(error, testConnectionResponse);
				}
			},
			{
				body: connectionTestBody,
				response: testConnectionResponse,
			},
		)
		.post(
			"/api/connection-settings/commands",
			({ body }) => {
				try {
					let result: ConnectionSettingsSnapshot;
					switch (body.type) {
						case "create-profile":
							result = settings.createProfile(body);
							break;
						case "apply-profile":
							result = settings.applyProfile(body);
							break;
						case "set-credential":
							result = settings.setCredential(body);
							break;
						case "reset-credential":
							result = settings.resetCredential(body);
							break;
						case "delete-profile":
							result = settings.deleteProfile(body);
							break;
						case "set-pinned-models":
							result = settings.setPinnedModels(body);
							break;
					}
					return { outcome: "applied" as const, settings: toSettingsPayload(result) };
				} catch (error) {
					return presentDomainError(error, commandResponse);
				}
			},
			{
				body: connectionCommandBody,
				response: commandResponse,
			},
		);
};

function toSettingsPayload(snapshot: ConnectionSettingsSnapshot) {
	return {
		revision: snapshot.revision,
		profiles: snapshot.profiles.map(toProfilePayload),
	};
}

function toProfilePayload(entry: ConnectionSettingsSnapshot["profiles"][number]) {
	return {
		...connectionProfileDraftOf(entry),
		id: entry.id,
		discoveryCatalog: [...entry.discoveryCatalog],
		textOnlyModels: [...entry.textOnlyModels],
		credentialConfigured: entry.credentialConfigured,
		headers: [...entry.headers],
	};
}

function toPresetProfilePayload(profile: DomainConnectionPreset["profile"]) {
	return connectionProfileDraftOf(profile);
}
