import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { ConversationSummary } from "./conversation";
import { conversationKey, refreshChatsBeforeNewBoxes } from "./conversation-query";

// SAFETY: refreshChatsBeforeNewBoxes reads only the Chat's id and Box pins.
const pinned = (id: number, boxVersions: Readonly<Record<string, string>>) => ({ id, boxVersions }) as ConversationSummary;

// @approved
//  Another tab installed and inserted a Box this client never listed. Its
// summaries have no staleness, so a cached Chat read before the install would
// keep lacking the Box's state once the catalog lists it, and the Box manager
// throws on that.
test("a pin naming a Box this client doesn't list reads every other cached Chat again first, and a known pin reads none", async () => {
	const client = new QueryClient();
	const reads = new Map<number, number>();
	for (const id of [1, 2, 3]) await client.prefetchQuery({ queryKey: conversationKey(id), queryFn: () => reads.set(id, (reads.get(id) ?? 0) + 1).get(id) });
	await refreshChatsBeforeNewBoxes(client, pinned(1, {}));
	expect([...reads]).toEqual([[1, 1], [2, 1], [3, 1]]);
	await refreshChatsBeforeNewBoxes(client, pinned(1, { "authored-new": "c71e" }));
	expect([...reads]).toEqual([[1, 1], [2, 2], [3, 2]]);
});
