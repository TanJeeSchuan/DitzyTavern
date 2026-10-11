import { phoneRead, type PhoneRead } from "../shared/contract/phone";
import { notFoundOutcome } from "../shared/contract/outcomes";
import { api } from "./lib/eden";
import { foundOrNull, requestOutcome } from "./lib/request-outcome";

export async function loadPhone(conversationId: number, signal?: AbortSignal): Promise<PhoneRead | null> {
	return foundOrNull(await requestOutcome(
		api.api.conversations({ id: conversationId }).boxes.phone.get({ fetch: { signal } }), phoneRead, notFoundOutcome,
	));
}
