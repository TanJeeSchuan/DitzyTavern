import type { TSchema } from "@sinclair/typebox";
import { useQuery } from "@tanstack/react-query";
import type { BoxId } from "../../shared/contract/box";
import { notFoundOutcome } from "../../shared/contract/outcomes";
import type { ConversationSummary } from "../conversation";
import { api } from "../lib/eden";
import { foundOrNull, requestOutcome } from "../lib/request-outcome";
import { loadBoxDelegate } from "../box-digest";
import { followsChanges } from "../server-changes";
import { chatBoxDescriptor } from "./registry";

/** @approved A delegating Box's notice read in a Chat, which follows the database, since its delegate's runs land without a Conversation revision. */
export const delegateReadKey = (conversationId: number, box: BoxId) => ["box-delegate", conversationId, box] as const;
export const useDelegateRead = (conversation: ConversationSummary, box: BoxId) => useQuery({
	queryKey: delegateReadKey(conversation.id, box),
	queryFn: ({ signal }) => loadBoxDelegate(conversation.id, box, signal),
	meta: followsChanges,
	enabled: chatBoxDescriptor(conversation, box)?.delegate !== undefined,
});

export async function loadBoxRead<Schema extends TSchema>(conversationId: number, box: BoxId, schema: Schema, signal?: AbortSignal) {
	return foundOrNull(await requestOutcome(api.api.conversations({ id: conversationId }).boxes({ box }).get({ fetch: { signal } }), schema, notFoundOutcome));
}

// @approved
//  A Box's window read, decoded with the Box's own schema. The key carries
// the Chat's revision, so the read refetches when the Chat changes, and the
// previous read stays as placeholder data meanwhile, so a window keeps what
// it shows, such as the Race's markers, through the refetch. A missing Chat
// reads as null. A delegating Box's key also carries how many of its
// delegate's runs have landed, from its notice read, so the window refetches
// when one lands without following every change, since a guest commits at
// the snapshot its read gave.
export const useBoxRead = <Schema extends TSchema>(conversation: ConversationSummary, box: BoxId, schema: Schema) => {
	const landed = useDelegateRead(conversation, box).data?.landed;
	return useQuery({
		queryKey: [box, conversation.id, conversation.revision, landed],
		queryFn: ({ signal }) => loadBoxRead(conversation.id, box, schema, signal),
		placeholderData: (previous) => previous,
	});
};
