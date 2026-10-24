import { raceRead, type RaceRead } from "./contract";
import { api, foundOrNull, notFoundOutcome, requestOutcome } from "@/box-sdk/client";

export async function loadRace(conversationId: number, signal?: AbortSignal): Promise<RaceRead | null> {
	return foundOrNull(await requestOutcome(
		api.api.conversations({ id: conversationId }).boxes({ box: "race" }).get({ fetch: { signal } }), raceRead, notFoundOutcome,
	));
}
