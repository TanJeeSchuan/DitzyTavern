import type { TypesafeSettingsCommand, TypesafeSettingsPayload } from "../shared/contract/typesafe";
import { api } from "./lib/eden";

export type TypesafeSettings = TypesafeSettingsPayload;
export type TypesafeSettingsResult = Awaited<ReturnType<typeof saveTypesafeSettings>>;

export async function loadTypesafeSettings(): Promise<TypesafeSettings> {
	const { data, error } = await api.api["typesafe-settings"].get();
	if (error || data === undefined || data === null) throw new Error("Typesafe Settings could not be loaded.");
	return data;
}

export async function saveTypesafeSettings(command: TypesafeSettingsCommand) {
	const failed = { outcome: "invalid" as const, reason: "Typesafe Settings could not be saved." };
	try {
		const { data, error } = await api.api["typesafe-settings"].commands.post(command);
		return error === null ? data : error.status === 409 || error.status === 422 ? error.value : failed;
	} catch { return failed; }
}
