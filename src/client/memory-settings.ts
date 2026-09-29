import type { MemorySettingsCommand, MemorySettingsPayload } from "../shared/contract/memory-settings";
import { api, domainOutcome } from "./lib/eden";

export type MemorySettings = MemorySettingsPayload;

export async function loadMemorySettings(): Promise<MemorySettings> {
	const { data, error } = await api.api["memory-settings"].get();
	if (error || data === undefined || data === null) throw new Error("Memory Settings could not be loaded.");
	return data;
}

export async function saveMemorySettings(command: MemorySettingsCommand) {
	const reason = "Memory Settings could not be saved.";
	try {
		const { data, error } = await api.api["memory-settings"].commands.post(command);
		return error === null ? data : domainOutcome(error.value, reason);
	} catch { return { outcome: "invalid" as const, reason }; }
}
