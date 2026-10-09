import type { StaticDecode } from "@sinclair/typebox";
import { api } from "./lib/eden";
import { requestData, requestOutcome, type RequestOutcome } from "./lib/request-outcome";
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
	connectionCommandErrors,
	connectionDiscoveryErrors,
	connectionDiscoveryResponse,
	connectionInvalidResponse,
	connectionPresetsResponse,
	connectionSettingsResponse,
	connectionSettingsApplied,
	connectionTestResponse,
} from "../shared/contract/connection-settings";
import { readOutcomeErrors } from "../shared/contract/outcomes";

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

export type ConnectionSettingsResult = RequestOutcome<
	StaticDecode<typeof connectionSettingsApplied>,
	StaticDecode<typeof connectionCommandErrors>
>;

export type DiscoveryResult = RequestOutcome<
	StaticDecode<typeof connectionDiscoveryResponse>,
	StaticDecode<typeof connectionDiscoveryErrors>
>;

// @approved
//  The Test Connection route models only the invalid envelope, so the read
// passes it as the single-member error union directly.
export type TestConnectionResult = RequestOutcome<
	StaticDecode<typeof connectionTestResponse>,
	StaticDecode<typeof connectionInvalidResponse>
>;

export type TestConnectionDraftInput = ConnectionTestDraftPayload;

export type ConnectionSettingsCommand = ConnectionSettingsCommandPayload;

export async function loadConnectionSettings(): Promise<ConnectionSettings> {
	return requestData(api.api["connection-settings"].get(), connectionSettingsResponse);
}

export async function loadConnectionPresets(): Promise<ConnectionPreset[]> {
	return (await requestData(api.api["connection-settings"].presets.get(), connectionPresetsResponse)).presets;
}

export async function saveConnectionCommand(
	command: ConnectionSettingsCommand,
): Promise<ConnectionSettingsResult> {
	return requestOutcome(
		api.api["connection-settings"].commands.post(command),
		connectionSettingsApplied,
		connectionCommandErrors,
	);
}

export async function testConnectionDraft(input: TestConnectionDraftInput): Promise<TestConnectionResult> {
	return requestOutcome(
		api.api["connection-settings"]["test-connection"].post(input),
		connectionTestResponse,
		connectionInvalidResponse,
	);
}

export async function refreshDiscoveryCatalog(profileId: number): Promise<DiscoveryResult> {
	return requestOutcome(
		api.api["connection-settings"].discovery.post({ profileId }),
		connectionDiscoveryResponse,
		connectionDiscoveryErrors,
	);
}

// @approved
//  The text-only mark owns the null projection: every consumer reads the
// boolean failed/applied split and no consumer needs the modeled failure
// envelopes.
export async function setTextOnlyModel(profileId: number, modelId: string, textOnly: boolean): Promise<ConnectionSettings | null> {
	const outcome = await requestOutcome(
		api.api["connection-settings"]["text-only-model"].post({ profileId, modelId, textOnly }),
		connectionSettingsApplied,
		readOutcomeErrors,
	);
	return outcome.outcome === "available" ? outcome.value.settings : null;
}
