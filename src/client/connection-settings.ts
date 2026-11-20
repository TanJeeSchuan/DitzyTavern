import { api } from "./lib/eden";
import { requestData } from "./lib/request-outcome";
import { requestOutcome } from "./lib/request-route-outcome";
import type {
	ConnectionHeaderOperationPayload,
	ConnectionPresetPayload,
	ConnectionProfileDraftPayload,
	ConnectionProfilePayload,
	ConnectionSettingsCommandPayload,
	ConnectionSettingsPayload,
	ConnectionTestDraftPayload,
} from "../shared/contract/connection-settings";
import {
	connectionCommandResponse,
	connectionDiscoveryResponse,
	connectionPresetsResponse,
	connectionSettingsResponse,
	connectionTestResponse,
	connectionTextOnlyResponse,
} from "../shared/contract/connection-settings";

export type ConnectionAdapter = ConnectionProfileDraftPayload["adapter"];
export type ConnectionHeaderOperation = ConnectionHeaderOperationPayload;
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

export type TestConnectionResult = Awaited<ReturnType<typeof testConnectionDraft>>;

export type TestConnectionDraftInput = ConnectionTestDraftPayload;

export type ConnectionSettingsCommand = ConnectionSettingsCommandPayload;

export async function loadConnectionSettings(signal?: AbortSignal): Promise<ConnectionSettings> {
	return requestData(api.api["connection-settings"].get({ fetch: { signal } }), connectionSettingsResponse[200]);
}

export async function loadConnectionPresets(signal?: AbortSignal): Promise<ConnectionPreset[]> {
	return (await requestData(api.api["connection-settings"].presets.get({ fetch: { signal } }), connectionPresetsResponse[200])).presets;
}

export async function saveConnectionCommand(command: ConnectionSettingsCommand) {
	return requestOutcome(
		api.api["connection-settings"].commands.post(command),
		connectionCommandResponse,
	);
}

export async function testConnectionDraft(input: TestConnectionDraftInput) {
	return requestOutcome(
		api.api["connection-settings"]["test-connection"].post(input),
		connectionTestResponse,
	);
}

export async function refreshDiscoveryCatalog(profileId: number) {
	return requestOutcome(
		api.api["connection-settings"].discovery.post({ profileId }),
		connectionDiscoveryResponse,
	);
}

// @approved
//  The text-only mark owns the null projection: every consumer reads the
// boolean failed/applied split and no consumer needs the modeled failure
// envelopes.
export async function setTextOnlyModel(profileId: number, modelId: string, textOnly: boolean): Promise<ConnectionSettings | null> {
	const outcome = await requestOutcome(
		api.api["connection-settings"]["text-only-model"].post({ profileId, modelId, textOnly }),
		connectionTextOnlyResponse,
	);
	return outcome.outcome === "available" ? outcome.value.settings : null;
}
