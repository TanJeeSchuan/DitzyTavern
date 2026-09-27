import type { TypesafeSettingsCommand, TypesafeSettingsPayload } from "../shared/contract/typesafe";
import { Value } from "@sinclair/typebox/value";
import { typesafeSettingsConflict, typesafeSettingsInvalid } from "../shared/contract/typesafe";
import { api } from "./lib/eden";

export type TypesafeSettings = TypesafeSettingsPayload;
export type TypesafeSettingsResult =
	| { outcome: "applied"; settings: TypesafeSettings }
	| { outcome: "conflict"; expectedRevision: number; actualRevision: number; currentSettings: TypesafeSettings }
	| { outcome: "invalid"; reason: string };

export async function loadTypesafeSettings(): Promise<TypesafeSettings> {
	const { data, error } = await api.api["typesafe-settings"].get();
	if (error || data === undefined || data === null) throw new Error("Typesafe Settings could not be loaded.");
	return data;
}

export async function saveTypesafeSettings(command: TypesafeSettingsCommand): Promise<TypesafeSettingsResult> {
	try {
		const { data, error } = await api.api["typesafe-settings"].commands.post(command);
		if (data !== undefined && data !== null) return data;
		const value = error?.value;
		if (value !== undefined && Value.Check(typesafeSettingsConflict, value)) return Value.Parse(typesafeSettingsConflict, value);
		if (value !== undefined && Value.Check(typesafeSettingsInvalid, value)) return Value.Parse(typesafeSettingsInvalid, value);
		return { outcome: "invalid", reason: "Typesafe Settings could not be saved." };
	} catch {
		return { outcome: "invalid", reason: "Typesafe Settings could not be saved." };
	}
}
