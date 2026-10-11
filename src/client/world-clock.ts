import { worldClockRead, type WorldClockRead } from "../shared/contract/box";
import { notFoundOutcome } from "../shared/contract/outcomes";
import { api } from "./lib/eden";
import { foundOrNull, requestOutcome } from "./lib/request-outcome";

export async function loadWorldClock(conversationId: number, signal?: AbortSignal): Promise<WorldClockRead | null> {
	return foundOrNull(await requestOutcome(
		api.api.conversations({ id: conversationId }).boxes({ box: "world-clock" }).get({ fetch: { signal } }),
		worldClockRead,
		notFoundOutcome,
	));
}
