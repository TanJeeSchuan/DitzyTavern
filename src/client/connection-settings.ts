export type ConnectionApiFormat =
	| "chat-completions"
	| "responses"
	| "anthropic-messages";
export type ModelBackend = "automatic" | "ai-sdk";
export type ConnectionAdapter = "openai-compatible" | "deepseek" | "openrouter";
export type ConnectionHeaderOperation =
	| { name: string; operation: "keep" }
	| { name: string; operation: "replace"; value: string }
	| { name: string; operation: "remove" };
export type OutputTokenRepresentation =
	| "automatic"
	| "max_tokens"
	| "max_completion_tokens"
	| "omit";
export type BackendOptionValue = string | number | boolean | null;
export type BackendOptions = Record<string, BackendOptionValue>;

export type ConnectionProfileDraft = {
	displayName: string;
	apiFormat: ConnectionApiFormat;
	requestUrl: string;
	modelsUrl: string;
	modelBackend: ModelBackend;
	adapter: ConnectionAdapter;
	outputTokenRepresentation: OutputTokenRepresentation;
	timeoutMs: number;
	pinnedModels: string[];
	backendOptions: BackendOptions;
};

export type ConnectionProfile = ConnectionProfileDraft & {
	id: number;
	discoveryCatalog: string[];
	credentialConfigured: boolean;
	headers: Array<{ name: string; configured: boolean }>;
};

export type ConnectionSettings = {
	revision: number;
	activeProfileId: number | null;
	profiles: ConnectionProfile[];
};

export type ConnectionPreset = {
	id: string;
	label: string;
	description: string;
	profile: ConnectionProfileDraft;
};

export type ConnectionSettingsResult =
	| { outcome: "applied"; settings: ConnectionSettings }
	| {
			outcome: "conflict";
			expectedRevision: number;
			actualRevision: number;
			currentSettings: ConnectionSettings;
		}
	| { outcome: "invalid"; reason: string }
	| { outcome: "not-found" };

export type DiscoveryResult =
	| { outcome: "success"; profile: ConnectionProfile; settingsRevision: number }
	| {
			outcome: "failure";
			kind: "authentication" | "endpoint" | "timeout" | "redirect" | "malformed-response";
			message: string;
		}
	| { outcome: "not-found" }
	| { outcome: "invalid"; reason: string };

export type TestConnectionFailureKind =
	| "authentication"
	| "endpoint"
	| "timeout"
	| "redirect"
	| "malformed-response"
	| "adapter-unavailable";

export type TestConnectionResult =
	| { outcome: "success"; message: string }
	| { outcome: "failure"; kind: TestConnectionFailureKind; message: string }
	| { outcome: "invalid"; reason: string };

export type TestConnectionDraftInput = {
	profileId?: number;
	profile: ConnectionProfileDraft;
	modelId: string;
	credential?: string | null;
	headers?: ConnectionHeaderOperation[];
};

export type ConnectionSettingsCommand =
	| {
			type: "create-profile";
			expectedRevision: number;
			profile: ConnectionProfileDraft;
			credential?: string | null;
			headers?: ConnectionHeaderOperation[];
		}
	| {
			type: "apply-profile";
		expectedRevision: number;
		profileId: number;
			profile: ConnectionProfileDraft;
			headers?: ConnectionHeaderOperation[];
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
			type: "set-pinned-models";
			expectedRevision: number;
			profileId: number;
			pinnedModels: string[];
		};

const json = async <T>(response: Response): Promise<T> => {
	const body: unknown = await response.json();
	if (!response.ok) {
		// SAFETY: callers select T from the known HTTP route response contract.
		return body as T;
	}
	// SAFETY: the server validates each response against the Elysia contract.
	return body as T;
};

export async function loadConnectionSettings(): Promise<ConnectionSettings> {
	const response = await fetch("/api/connection-settings");
	if (!response.ok) throw new Error("Unable to load Connection Settings.");
	return json<ConnectionSettings>(response);
}

export async function loadConnectionPresets(): Promise<ConnectionPreset[]> {
	const response = await fetch("/api/connection-settings/presets");
	if (!response.ok) throw new Error("Unable to load Connection Presets.");
	const body = await json<{ presets: ConnectionPreset[] }>(response);
	return body.presets;
}

export async function saveConnectionCommand(
	command: ConnectionSettingsCommand,
): Promise<ConnectionSettingsResult> {
	const response = await fetch("/api/connection-settings/commands", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(command),
	});
	return json<ConnectionSettingsResult>(response);
}

export async function testConnectionDraft(input: TestConnectionDraftInput): Promise<TestConnectionResult> {
	const response = await fetch("/api/connection-settings/test-connection", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	return json<TestConnectionResult>(response);
}

export async function refreshDiscoveryCatalog(profileId: number): Promise<DiscoveryResult> {
	const response = await fetch("/api/connection-settings/discovery", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ profileId }),
	});
	return json<DiscoveryResult>(response);
}
