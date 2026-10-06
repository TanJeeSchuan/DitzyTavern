import type { SemanticTriggerSettingsCommand, SemanticTriggerSettingsPayload } from "../shared/contract/semantic-trigger-settings";
import { api, domainOutcome } from "./lib/eden";

export type SemanticTriggerSettings = SemanticTriggerSettingsPayload;
export type SemanticTriggerSettingsResult = Awaited<ReturnType<typeof saveSemanticTriggerSettings>>;

export async function loadSemanticTriggerSettings(): Promise<SemanticTriggerSettings> {
	const { data, error } = await api.api["semantic-trigger-settings"].get();
	if (error || data === undefined || data === null) throw new Error("Semantic Trigger Settings could not be loaded.");
	return data;
}

export async function saveSemanticTriggerSettings(command: SemanticTriggerSettingsCommand) {
	const reason = "Semantic Trigger Settings could not be saved.";
	try {
		const { data, error } = await api.api["semantic-trigger-settings"].commands.post(command);
		return error === null ? data : domainOutcome(error.value, reason);
	} catch { return { outcome: "invalid" as const, reason }; }
}

