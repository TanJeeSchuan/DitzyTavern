import type { StaticDecode } from "@sinclair/typebox";
import { api } from "./lib/eden";
import { requestData, requestOutcome, type RequestOutcome } from "./lib/request-outcome";
import type { MemorySettingsCommand, MemorySettingsPayload } from "../shared/contract/memory-settings";
import { memorySettingsApplied, memorySettingsCommandErrors, memorySettingsResponse } from "../shared/contract/memory-settings";

export type MemorySettings = MemorySettingsPayload;

export type MemorySettingsCommandResult = RequestOutcome<
	StaticDecode<typeof memorySettingsApplied>,
	StaticDecode<typeof memorySettingsCommandErrors>
>;

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
