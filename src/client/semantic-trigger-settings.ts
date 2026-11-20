import { api } from "./lib/eden";
import { requestData } from "./lib/request-outcome";
import { requestOutcome } from "./lib/request-route-outcome";
import type { SemanticTriggerSettingsCommand, SemanticTriggerSettingsPayload } from "../shared/contract/semantic-trigger-settings";
import {
	semanticTriggerSettingsCommandResponse,
	semanticTriggerSettingsReadResponse,
} from "../shared/contract/semantic-trigger-settings";

export type SemanticTriggerSettings = SemanticTriggerSettingsPayload;

export async function loadSemanticTriggerSettings(): Promise<SemanticTriggerSettings> {
	return requestData(api.api["semantic-trigger-settings"].get(), semanticTriggerSettingsReadResponse[200]);
}

export async function saveSemanticTriggerSettings(command: SemanticTriggerSettingsCommand) {
	return requestOutcome(
		api.api["semantic-trigger-settings"].commands.post(command),
		semanticTriggerSettingsCommandResponse,
	);
}
