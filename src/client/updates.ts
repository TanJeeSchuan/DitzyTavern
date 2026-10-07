import { Value } from "@sinclair/typebox/value";
import { updateStatus, type UpdateStatus } from "../shared/contract/updates";
import { api } from "./lib/eden";

export async function checkUpdates(): Promise<UpdateStatus> {
	const { data, error } = await api.api.updates.check.post();
	if (error || !data) throw new Error("Update check could not be requested.");
	return data;
}

export async function setAutomaticUpdateChecks(enabled: boolean): Promise<UpdateStatus> {
	const { data, error } = await api.api.updates.automatic.post({ enabled });
	if (error || !data) throw new Error("Automatic update checks could not be saved.");
	return data;
}

export function observeUpdates(onStatus: (state: UpdateStatus) => void, onError: () => void) {
	const source = new EventSource("/api/updates/events");
	source.addEventListener("status", (event) => {
		try { onStatus(Value.Decode(updateStatus, JSON.parse(event.data))); } catch { onError(); }
	});
	source.onerror = onError;
	return () => source.close();
}
