import type {
	ConnectionHeaderOperationPayload,
	ConnectionPresetPayload,
	ConnectionProfileDraftPayload,
	ConnectionProfilePayload,
	ConnectionSettingsPayload,
} from "../../shared/contract/connection-settings";

// ==[HUMAN APPROVED]== The shared wire contract is the canonical declaration of every Connection
// Settings shape; the server-side types below derive from it so the two
// representations can no longer drift apart.
export type ConnectionApiFormat = ConnectionProfileDraftPayload["apiFormat"];

export type ChatApiFormat = Exclude<ConnectionApiFormat, "embeddings" | "system-one">;

export type ModelBackend = ConnectionProfileDraftPayload["modelBackend"];

export type ConnectionAdapter = ConnectionProfileDraftPayload["adapter"];

export type OutputTokenRepresentation = ConnectionProfileDraftPayload["outputTokenRepresentation"];

export type ConnectionHeaderOperation = ConnectionHeaderOperationPayload;

// Null or zero disables inactivity expiry. A positive value is the maximum
// quiet interval, not a total Generation duration.
export type ConnectionProfileDraft = ConnectionProfileDraftPayload;

export type RedactedHeader = ConnectionProfilePayload["headers"][number];

export type ConnectionProfile = ConnectionProfilePayload;

export interface ConnectionProfileSecretSnapshot {
	readonly credential: string | null;
	readonly headers: Readonly<Record<string, string>>;
}

export type ConnectionSettingsSnapshot = ConnectionSettingsPayload;

export type ConnectionPreset = ConnectionPresetPayload;

export interface CreateConnectionProfileInput {
	readonly expectedRevision: number;
	readonly profile: ConnectionProfileDraft;
	readonly credential?: string | null;
	readonly headers?: readonly ConnectionHeaderOperation[];
}

export interface ApplyConnectionProfileInput {
	readonly expectedRevision: number;
	readonly profileId: number;
	readonly profile: ConnectionProfileDraft;
	readonly credential?: string;
	readonly headers?: readonly ConnectionHeaderOperation[];
}

export interface SetConnectionCredentialInput {
	readonly expectedRevision: number;
	readonly profileId: number;
	readonly credential: string;
}

export interface ResetConnectionCredentialInput {
	readonly expectedRevision: number;
	readonly profileId: number;
	readonly confirmed: boolean;
}

export interface DeleteConnectionProfileInput {
	readonly expectedRevision: number;
	readonly profileId: number;
}

export interface SetPinnedModelsInput {
	readonly expectedRevision: number;
	readonly profileId: number;
	readonly pinnedModels: readonly string[];
}

export interface SetTextOnlyModelInput {
	readonly profileId: number;
	readonly modelId: string;
	readonly textOnly: boolean;
}

export interface ConnectionSettingsModule {
	get(): ConnectionSettingsSnapshot;
	getProfileSecrets(profileId: number): ConnectionProfileSecretSnapshot | null;
	listPresets(): readonly ConnectionPreset[];
	createProfile(input: CreateConnectionProfileInput): ConnectionSettingsSnapshot;
	applyProfile(input: ApplyConnectionProfileInput): ConnectionSettingsSnapshot;
	deleteProfile(input: DeleteConnectionProfileInput): ConnectionSettingsSnapshot;
	setPinnedModels(input: SetPinnedModelsInput): ConnectionSettingsSnapshot;
	replaceDiscoveryCatalog(
		profileId: number,
		models: readonly string[],
		expectedRevision: number,
		expectedModelsUrl: string,
	): ConnectionProfile;
	setTextOnlyModel(input: SetTextOnlyModelInput): ConnectionSettingsSnapshot;
	setCredential(input: SetConnectionCredentialInput): ConnectionSettingsSnapshot;
	resetCredential(input: ResetConnectionCredentialInput): ConnectionSettingsSnapshot;
}
