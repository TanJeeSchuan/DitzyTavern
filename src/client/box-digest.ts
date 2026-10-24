import { boxDescriptors, type BoxDescriptors, type DigestBoxId } from "../shared/contract/box";
import { digestRead, digestStatusRead, type DigestRead } from "../shared/contract/box-digest";
import { notFoundOutcome } from "../shared/contract/outcomes";
import { api } from "./lib/eden";
import { foundOrNull, requestOutcome } from "./lib/request-outcome";

export type BoxDigest = DigestRead<BoxDescriptors[DigestBoxId]["record"]>;
export type BoxDigestPassage = BoxDigest["passages"][number];

// @approved
//  A digesting Box's passage timeline read and catch-up, decoded with the
// digest read of the Box's own record schema.
const boxRoute = (conversationId: number, box: DigestBoxId) => api.api.conversations({ id: conversationId }).boxes({ box });
const readOf = (box: DigestBoxId) => digestRead(boxDescriptors[box].record);

export async function loadBoxDigest(conversationId: number, box: DigestBoxId, signal?: AbortSignal): Promise<BoxDigest | null> {
	return foundOrNull(await requestOutcome(boxRoute(conversationId, box).get({ fetch: { signal } }), readOf(box), notFoundOutcome));
}

export async function loadBoxDigestStatus(conversationId: number, box: DigestBoxId, signal?: AbortSignal): Promise<string | null | undefined> {
	return (await foundOrNull(await requestOutcome(boxRoute(conversationId, box).status.get({ fetch: { signal } }), digestStatusRead, notFoundOutcome)))?.status;
}

/** @approved Starting resolves with the read that already carries the new run's progress. */
export async function startBoxCatchUp(conversationId: number, box: DigestBoxId): Promise<BoxDigest | null> {
	return foundOrNull(await requestOutcome(boxRoute(conversationId, box)["catch-up"].post(), readOf(box), notFoundOutcome));
}

/** @approved Cancelling resolves with the read that no longer carries a run. */
export async function cancelBoxCatchUp(conversationId: number, box: DigestBoxId): Promise<BoxDigest | null> {
	return foundOrNull(await requestOutcome(boxRoute(conversationId, box)["catch-up"].delete(), readOf(box), notFoundOutcome));
}

/** @approved Digesting one passage resolves with the read as it stands; the passage's record lands later. */
export async function digestBoxPassage(conversationId: number, box: DigestBoxId, variantId: number): Promise<BoxDigest | null> {
	return foundOrNull(await requestOutcome(boxRoute(conversationId, box).digest.post({ variantId }), readOf(box), notFoundOutcome));
}
