import type { MemorySettingsCommand, MemorySettingsPayload } from "../shared/contract/memory-settings";
import { Value } from "@sinclair/typebox/value";
import { memorySettingsConflict, memorySettingsInvalid } from "../shared/contract/memory-settings";
import { api } from "./lib/eden";

export type MemorySettings = MemorySettingsPayload;
export type MemorySettingsResult =
	| { outcome: "applied"; settings: MemorySettings }
	| { outcome: "conflict"; expectedRevision: number; actualRevision: number; currentSettings: MemorySettings }
	| { outcome: "invalid"; reason: string };

export async function loadMemorySettings(): Promise<MemorySettings> {
	const { data, error } = await api.api["memory-settings"].get();
	if (error || data === undefined || data === null) throw new Error("Memory Settings could not be loaded.");
	return data;
}

export async function saveMemorySettings(command: MemorySettingsCommand): Promise<MemorySettingsResult> {
	try {
		const { data, error } = await api.api["memory-settings"].commands.post(command);
		if (data !== undefined && data !== null) return data;
		const value = error?.value;
		if (value !== undefined && Value.Check(memorySettingsConflict, value)) return Value.Parse(memorySettingsConflict, value);
		if (value !== undefined && Value.Check(memorySettingsInvalid, value)) return Value.Parse(memorySettingsInvalid, value);
		return { outcome: "invalid", reason: "Memory Settings could not be saved." };
	} catch {
		return { outcome: "invalid", reason: "Memory Settings could not be saved." };
	}
}
