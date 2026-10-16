import { phoneRead, type PhoneRead } from "./contract";
import { api, foundOrNull, notFoundOutcome, requestOutcome } from "@/box-sdk/client";

export async function loadPhone(conversationId: number, signal?: AbortSignal): Promise<PhoneRead | null> {
	return foundOrNull(await requestOutcome(
		api.api.conversations({ id: conversationId }).boxes({ box: "phone" }).get({ fetch: { signal } }), phoneRead, notFoundOutcome,
	));
}
