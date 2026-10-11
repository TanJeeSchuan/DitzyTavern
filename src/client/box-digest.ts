import type { StaticDecode, TSchema } from "@sinclair/typebox";
import type { DigestBoxId } from "../shared/contract/box";
import { notFoundOutcome } from "../shared/contract/outcomes";
import { api } from "./lib/eden";
import { foundOrNull, requestOutcome } from "./lib/request-outcome";

// @approved
//  A digesting Box's window read and catch-up, decoded with the Box's own
// digest read schema.
const boxRoute = (conversationId: number, box: DigestBoxId) => api.api.conversations({ id: conversationId }).boxes({ box });

export async function loadBoxDigest<Read extends TSchema>(conversationId: number, box: DigestBoxId, read: Read, signal?: AbortSignal): Promise<StaticDecode<Read> | null> {
	return foundOrNull(await requestOutcome(boxRoute(conversationId, box).get({ fetch: { signal } }), read, notFoundOutcome));
}

/** @approved Starting resolves with the read that already carries the new run's progress. */
export async function startBoxCatchUp<Read extends TSchema>(conversationId: number, box: DigestBoxId, read: Read): Promise<StaticDecode<Read> | null> {
	return foundOrNull(await requestOutcome(boxRoute(conversationId, box)["catch-up"].post(), read, notFoundOutcome));
}

/** @approved Cancelling resolves with the read that no longer carries a run. */
export async function cancelBoxCatchUp<Read extends TSchema>(conversationId: number, box: DigestBoxId, read: Read): Promise<StaticDecode<Read> | null> {
	return foundOrNull(await requestOutcome(boxRoute(conversationId, box)["catch-up"].delete(), read, notFoundOutcome));
}
