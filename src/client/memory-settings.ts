import { api } from "./lib/eden";
import { requestData, requestOutcome } from "./lib/request-outcome";
import { memorySettingsApplied, memorySettingsCommandErrors, memorySettingsResponse, type MemorySettingsCommand, type MemorySettingsPayload } from "./box-windows/registry";

export type MemorySettings = MemorySettingsPayload;

export async function loadMemorySettings(): Promise<MemorySettings> {
	return requestData(api.api["memory-settings"].get(), memorySettingsResponse);
}

export async function saveMemorySettings(command: MemorySettingsCommand) {
	return requestOutcome(
		api.api["memory-settings"].commands.post(command),
		memorySettingsApplied,
		memorySettingsCommandErrors,
	);
}
