import type {
	EmbeddingModelDiscoveryResult,
	EmbeddingSettingsCommand,
	EmbeddingSettingsPayload,
	EmbeddingTestInput as SharedEmbeddingTestInput,
	EmbeddingTestResult as SharedEmbeddingTestResult,
} from "../shared/contract/embedding-settings";

export type EmbeddingTestInput = SharedEmbeddingTestInput;
export type EmbeddingTestResult = SharedEmbeddingTestResult;
import { api } from "./lib/eden";

export type EmbeddingSettings = EmbeddingSettingsPayload;
export type EmbeddingSettingsResult =
	| { outcome: "applied"; settings: EmbeddingSettings }
	| { outcome: "conflict"; expectedRevision: number; actualRevision: number; currentSettings: EmbeddingSettings }
	| { outcome: "invalid"; reason: string };

export async function loadEmbeddingSettings(): Promise<EmbeddingSettings> {
	const { data, error } = await api.api["embedding-settings"].get();
	if (error || data === undefined || data === null) throw new Error("Embedding Settings could not be loaded.");
	return data;
}

export async function refreshEmbeddingModels(): Promise<EmbeddingModelDiscoveryResult> {
	const { data } = await api.api["embedding-settings"].discovery.post();
	return data ?? { outcome: "failure", kind: "endpoint", message: "Model discovery request failed." };
}

export async function testEmbeddingSettings(input: EmbeddingTestInput): Promise<EmbeddingTestResult> {
	const { data, error } = await api.api["embedding-settings"].test.post(input);
	if (data !== null) return data;
	if (error?.status === 422) return error.value;
	return { outcome: "invalid", reason: "Embedding service test could not be completed." };
}

export async function saveEmbeddingSettings(command: EmbeddingSettingsCommand): Promise<EmbeddingSettingsResult> {
	try {
		const { data, error } = await api.api["embedding-settings"].commands.post(command);
		if (data !== undefined && data !== null) return data;
		// ==[HUMAN APPROVED]== SAFETY: Eden's typed error union is narrowed to the public outcome fields before they are read.
		const value = error?.value as {
			outcome?: string;
			reason?: string;
			expectedRevision?: number;
			actualRevision?: number;
			currentSettings?: EmbeddingSettings;
		} | null;
		if (value?.outcome === "conflict" && value.currentSettings !== undefined) {
			return {
				outcome: "conflict",
				expectedRevision: value.expectedRevision ?? ("expectedRevision" in command ? command.expectedRevision : 0),
				actualRevision: value.actualRevision ?? value.currentSettings.revision,
				currentSettings: value.currentSettings,
			};
		}
		return { outcome: "invalid", reason: value?.reason ?? "Embedding Settings could not be saved." };
	} catch {
		return { outcome: "invalid", reason: "Embedding Settings could not be saved." };
	}
}

export type EmbeddingSettingsDraft = Pick<EmbeddingSettings, "endpoint" | "model" | "deadlineMs"> & {
		credential: string;
};

export const draftFromEmbeddingSettings = (settings: EmbeddingSettings): EmbeddingSettingsDraft => ({
	endpoint: settings.endpoint,
	model: settings.model,
	deadlineMs: settings.deadlineMs,
	credential: "",
});
