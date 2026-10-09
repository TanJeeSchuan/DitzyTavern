import { Value } from "@sinclair/typebox/value";
import { updateStatus, type UpdateStatus } from "../shared/contract/updates";
import { api } from "./lib/eden";
import { requestData } from "./lib/request-outcome";

export async function checkUpdates(): Promise<UpdateStatus> {
	return requestData(api.api.updates.check.post(), updateStatus);
}

export async function setAutomaticUpdateChecks(enabled: boolean): Promise<UpdateStatus> {
	return requestData(api.api.updates.automatic.post({ enabled }), updateStatus);
}

export function observeUpdates(onStatus: (state: UpdateStatus) => void, onError: () => void) {
	const source = new EventSource("/api/updates/events");
	source.addEventListener("status", (event) => {
		try { onStatus(Value.Decode(updateStatus, JSON.parse(event.data))); } catch { onError(); }
	});
	source.onerror = onError;
	return () => source.close();
}
