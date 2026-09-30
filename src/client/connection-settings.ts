import { api } from "./lib/eden";
import type {
	ConnectionDiscoveryResultPayload,
	ConnectionHeaderOperationPayload,
	ConnectionPresetPayload,
	ConnectionProfileDraftPayload,
	ConnectionProfilePayload,
	ConnectionSettingsCommandPayload,
	ConnectionSettingsCommandResultPayload,
	ConnectionSettingsPayload,
	ConnectionTestDraftPayload,
	ConnectionTestResultPayload,
} from "../shared/contract/connection-settings";

export type ConnectionApiFormat = ConnectionProfileDraftPayload["apiFormat"];
export type ModelBackend = ConnectionProfileDraftPayload["modelBackend"];
export type ConnectionAdapter = ConnectionProfileDraftPayload["adapter"];
export type ConnectionHeaderOperation = ConnectionHeaderOperationPayload;
export type OutputTokenRepresentation = ConnectionProfileDraftPayload["outputTokenRepresentation"];
export type ConnectionProfileDraft = ConnectionProfileDraftPayload;
export type ConnectionProfile = ConnectionProfilePayload;
export type ConnectionSettings = ConnectionSettingsPayload;
export type ConnectionPreset = ConnectionPresetPayload;

export const CONNECTION_ADAPTER_LABELS = {
	deepseek: "DeepSeek",
	openrouter: "OpenRouter",
	"openai-compatible": "OpenAI Compatible",
} satisfies Record<ConnectionAdapter, string>;

export const isEmbeddingsProfile = (profile: ConnectionProfile): boolean => profile.apiFormat === "embeddings";

export type ConnectionSettingsResult = ConnectionSettingsCommandResultPayload;

export type DiscoveryResult =
	ConnectionDiscoveryResultPayload
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
	ConnectionTestResultPayload
	| { outcome: "invalid"; reason: string };

export type TestConnectionDraftInput = ConnectionTestDraftPayload;

export type ConnectionSettingsCommand = ConnectionSettingsCommandPayload;

export async function loadConnectionSettings(): Promise<ConnectionSettings> {
	const { data, error } = await api.api["connection-settings"].get();
	if (error || data === undefined) throw new Error("Unable to load Connection Settings.");
	return data;
}

export async function loadConnectionPresets(): Promise<ConnectionPreset[]> {
	const { data, error } = await api.api["connection-settings"].presets.get();
	if (error || data === undefined) throw new Error("Unable to load Connection Presets.");
	return data.presets;
}

export async function saveConnectionCommand(
	command: ConnectionSettingsCommand,
): Promise<ConnectionSettingsResult> {
	const { data } = await api.api["connection-settings"].commands.post(command);
	if (data !== undefined && data !== null) return data;
	return { outcome: "invalid", reason: "Connection Settings request failed." };
}

export async function testConnectionDraft(input: TestConnectionDraftInput): Promise<TestConnectionResult> {
	const { data } = await api.api["connection-settings"]["test-connection"].post(input);
	if (data !== undefined && data !== null) return data;
	return { outcome: "invalid", reason: "Test Connection request failed." };
}

export async function refreshDiscoveryCatalog(profileId: number): Promise<DiscoveryResult> {
	const { data } = await api.api["connection-settings"].discovery.post({ profileId });
	if (data !== undefined && data !== null) return data;
	return { outcome: "invalid", reason: "Model discovery request failed." };
}
