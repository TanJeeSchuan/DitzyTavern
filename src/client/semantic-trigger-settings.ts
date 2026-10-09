import { api } from "./lib/eden";
import { requestData, requestOutcome } from "./lib/request-outcome";
import type { SemanticTriggerSettingsCommand, SemanticTriggerSettingsPayload } from "../shared/contract/semantic-trigger-settings";
import {
	semanticTriggerSettings,
	semanticTriggerSettingsApplied,
	semanticTriggerSettingsCommandErrors,
} from "../shared/contract/semantic-trigger-settings";

export type SemanticTriggerSettings = SemanticTriggerSettingsPayload;
export type SemanticTriggerSettingsResult = Awaited<ReturnType<typeof saveSemanticTriggerSettings>>;

export async function loadSemanticTriggerSettings(): Promise<SemanticTriggerSettings> {
	return requestData(api.api["semantic-trigger-settings"].get(), semanticTriggerSettings);
}

export async function saveSemanticTriggerSettings(command: SemanticTriggerSettingsCommand) {
	return requestOutcome(
		api.api["semantic-trigger-settings"].commands.post(command),
		semanticTriggerSettingsApplied,
		semanticTriggerSettingsCommandErrors,
	);
}
