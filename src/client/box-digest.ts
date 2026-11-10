import { boxRecordSchema, type BoxDescriptor, type BoxId } from "../shared/contract/box";
import { delegateRead, digestRead, digestStatusRead, type DelegateRead, type DigestRead } from "../shared/contract/box-digest";
import { notFoundOutcome } from "../shared/contract/outcomes";
import { api } from "./lib/eden";
import { foundOrNull, requestOutcome } from "./lib/request-outcome";

export type BoxDigest = DigestRead<ReturnType<typeof boxRecordSchema>>;
export type BoxDigestPassage = BoxDigest["passages"][number];

// @approved
//  A digesting Box's passage timeline read and catch-up, decoded with the
// digest read of the record schema of the version the Chat runs.
const boxRoute = (conversationId: number, box: BoxId) => api.api.conversations({ id: conversationId }).boxes({ box });
const readOf = (descriptor: BoxDescriptor) => digestRead(boxRecordSchema(descriptor));

export async function loadBoxDigest(conversationId: number, descriptor: BoxDescriptor, signal?: AbortSignal): Promise<BoxDigest | null> {
	return foundOrNull(await requestOutcome(boxRoute(conversationId, descriptor.id).get({ fetch: { signal } }), readOf(descriptor), notFoundOutcome));
}

export async function loadBoxDigestStatus(conversationId: number, box: BoxId, signal?: AbortSignal): Promise<string | null | undefined> {
	return (await foundOrNull(await requestOutcome(boxRoute(conversationId, box).status.get({ fetch: { signal } }), digestStatusRead, notFoundOutcome)))?.status;
}

/** @approved Starting resolves with the read that already carries the new run's progress. */
export async function startBoxCatchUp(conversationId: number, descriptor: BoxDescriptor): Promise<BoxDigest | null> {
	return foundOrNull(await requestOutcome(boxRoute(conversationId, descriptor.id)["catch-up"].post(), readOf(descriptor), notFoundOutcome));
}

/** @approved Cancelling resolves with the read that no longer carries a run. */
export async function cancelBoxCatchUp(conversationId: number, descriptor: BoxDescriptor): Promise<BoxDigest | null> {
	return foundOrNull(await requestOutcome(boxRoute(conversationId, descriptor.id)["catch-up"].delete(), readOf(descriptor), notFoundOutcome));
}

/** @approved Digesting one passage resolves with the read as it stands; the passage's record lands later. */
export async function digestBoxPassage(conversationId: number, descriptor: BoxDescriptor, passage: { variantId: number }): Promise<BoxDigest | null> {
	return foundOrNull(await requestOutcome(boxRoute(conversationId, descriptor.id).digest.post(passage), readOf(descriptor), notFoundOutcome));
}

/** @approved A delegating Box's notice read: its delegate setting and the first passage whose run failed. */
export async function loadBoxDelegate(conversationId: number, box: BoxId, signal?: AbortSignal): Promise<DelegateRead | null> {
	return foundOrNull(await requestOutcome(boxRoute(conversationId, box).delegate.get({ fetch: { signal } }), delegateRead, notFoundOutcome));
}

/** @approved Retrying one passage's delegate run resolves with the notice read as it stands; the record lands later. */
export async function retryBoxDelegate(conversationId: number, box: BoxId, passage: { variantId: number }): Promise<DelegateRead | null> {
	return foundOrNull(await requestOutcome(boxRoute(conversationId, box).digest.post(passage), delegateRead, notFoundOutcome));
}
