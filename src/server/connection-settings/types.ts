export type ConnectionApiFormat =
	| "chat-completions"
	| "responses"
	| "anthropic-messages";

export type ModelBackend = "automatic" | "ai-sdk";

export type ConnectionAdapter =
	| "openai-compatible"
	| "deepseek"
	| "openrouter";

export type OutputTokenRepresentation =
	| "automatic"
	| "max_tokens"
	| "max_completion_tokens"
	| "omit";

export type BackendOptionValue = string | number | boolean | null;
export type BackendOptions = Readonly<Record<string, BackendOptionValue>>;

export interface ConnectionProfileDraft {
	readonly displayName: string;
	readonly apiFormat: ConnectionApiFormat;
	readonly requestUrl: string;
	readonly modelsUrl: string;
	readonly modelBackend: ModelBackend;
	readonly adapter: ConnectionAdapter;
	readonly outputTokenRepresentation: OutputTokenRepresentation;
	// Null or zero disables inactivity expiry. A positive value is the maximum
	// quiet interval, not a total Generation duration.
	readonly timeoutMs: number | null;
	readonly pinnedModels: readonly string[];
	readonly backendOptions: BackendOptions;
}

export interface RedactedHeader {
	readonly name: string;
	readonly configured: boolean;
}

export type ConnectionHeaderOperation =
	| { readonly name: string; readonly operation: "keep" }
	| { readonly name: string; readonly operation: "replace"; readonly value: string }
	| { readonly name: string; readonly operation: "remove" };

export interface ConnectionProfile extends ConnectionProfileDraft {
	readonly id: number;
	readonly credentialConfigured: boolean;
	readonly headers: readonly RedactedHeader[];
}

export interface ConnectionProfileSecretSnapshot {
	readonly credential: string | null;
	readonly headers: Readonly<Record<string, string>>;
}

export interface ConnectionSettingsSnapshot {
	readonly revision: number;
	readonly activeProfileId: number | null;
	readonly profiles: readonly ConnectionProfile[];
}

export interface ConnectionPreset {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly profile: ConnectionProfileDraft;
}

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

export interface ActivateConnectionProfileInput {
	readonly expectedRevision: number;
	readonly profileId: number;
}

export interface DeleteConnectionProfileInput {
	readonly expectedRevision: number;
	readonly profileId: number;
	readonly replacementProfileId?: number | null;
}

export interface ConnectionSettingsModule {
	get(): ConnectionSettingsSnapshot;
	getProfileSecrets(profileId: number): ConnectionProfileSecretSnapshot | null;
	listPresets(): readonly ConnectionPreset[];
	createProfile(input: CreateConnectionProfileInput): ConnectionSettingsSnapshot;
	applyProfile(input: ApplyConnectionProfileInput): ConnectionSettingsSnapshot;
	activateProfile(input: ActivateConnectionProfileInput): ConnectionSettingsSnapshot;
	deleteProfile(input: DeleteConnectionProfileInput): ConnectionSettingsSnapshot;
	setCredential(input: SetConnectionCredentialInput): ConnectionSettingsSnapshot;
	resetCredential(input: ResetConnectionCredentialInput): ConnectionSettingsSnapshot;
}
