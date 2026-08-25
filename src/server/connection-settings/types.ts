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
	readonly timeoutMs: number;
	readonly pinnedModels: readonly string[];
	readonly backendOptions: BackendOptions;
}

export interface RedactedHeader {
	readonly name: string;
	readonly configured: boolean;
}

export interface ConnectionProfile extends ConnectionProfileDraft {
	readonly id: number;
	readonly credentialConfigured: boolean;
	readonly headers: readonly RedactedHeader[];
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
}

export interface ApplyConnectionProfileInput {
	readonly expectedRevision: number;
	readonly profileId: number;
	readonly profile: ConnectionProfileDraft;
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

export interface ConnectionSettingsModule {
	get(): ConnectionSettingsSnapshot;
	listPresets(): readonly ConnectionPreset[];
	createProfile(input: CreateConnectionProfileInput): ConnectionSettingsSnapshot;
	applyProfile(input: ApplyConnectionProfileInput): ConnectionSettingsSnapshot;
	setCredential(input: SetConnectionCredentialInput): ConnectionSettingsSnapshot;
	resetCredential(input: ResetConnectionCredentialInput): ConnectionSettingsSnapshot;
}
