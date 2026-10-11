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

const catchUp = (conversationId: number) => api.api.conversations({ id: conversationId }).boxes({ box: "world-clock" })["catch-up"];

/** @approved Starting resolves with the read that already carries the new run's progress. */
export async function startWorldClockCatchUp(conversationId: number): Promise<WorldClockRead | null> {
	return foundOrNull(await requestOutcome(catchUp(conversationId).post(), worldClockRead, notFoundOutcome));
}

/** @approved Cancelling resolves with the read that no longer carries a run. */
export async function cancelWorldClockCatchUp(conversationId: number): Promise<WorldClockRead | null> {
	return foundOrNull(await requestOutcome(catchUp(conversationId).delete(), worldClockRead, notFoundOutcome));
}
