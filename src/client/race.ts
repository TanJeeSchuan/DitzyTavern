import { raceRead, type RaceRead } from "../shared/contract/race";
import { notFoundOutcome } from "../shared/contract/outcomes";
import { api } from "./lib/eden";
import { foundOrNull, requestOutcome } from "./lib/request-outcome";

export async function loadRace(conversationId: number, signal?: AbortSignal): Promise<RaceRead | null> {
	return foundOrNull(await requestOutcome(
		api.api.conversations({ id: conversationId }).boxes.race.get({ fetch: { signal } }), raceRead, notFoundOutcome,
	));
}
