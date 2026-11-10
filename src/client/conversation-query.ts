import { skipToken, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { loadConversation, type ConversationSummary } from "./conversation";
import { variantTextKey } from "./story/variant-text";
import { boxVersionsBuilt, loadBoxVersions } from "./box-windows/registry";

export const conversationKey = (id: number | null) => ["conversation", id] as const;

// @approved
//  One abortable query step: combine the query's signal with the owner's, yield
// once so an already-aborted owner rejects before the request, and surface
// cancellation before and after the load.
export const cancellableFetch = async <T>(
	signal: AbortSignal,
	owner: AbortSignal | undefined,
	load: (cancellation: AbortSignal) => Promise<T>,
): Promise<T> => {
	const cancellation = owner ? AbortSignal.any([signal, owner]) : signal;
	await Promise.resolve();
	cancellation.throwIfAborted();
	const value = await load(cancellation);
	cancellation.throwIfAborted();
	return value;
};

// @approved
//  A newer revision can change any page and any Variant's text: the story
// reads them again when it next shows them. An older copy never replaces the
// cached one.
const adoptConversation = (client: QueryClient, incoming: ConversationSummary | null, id: number) => {
	const current = client.getQueryData<ConversationSummary | null>(conversationKey(id)) ?? null;
	if (incoming !== null && incoming.revision > (current?.revision ?? 0)) {
		void client.invalidateQueries({ queryKey: ["conversation-history", id] });
		void client.invalidateQueries({ queryKey: variantTextKey(id) });
	}
	return incoming !== null && current !== null && current.revision > incoming.revision ? current : incoming;
};

// @approved
//  A summary is published once this client has built every Box version the
// Chat pins, so no surface reads it before its versions resolve; one that
// needs a version built waits for it, and the revision check keeps a newer
// summary published meanwhile.
export const publishConversation = (client: QueryClient, conversation: ConversationSummary) => {
	const queryKey = conversationKey(conversation.id);
	const publish = () => {
		void client.cancelQueries({ queryKey });
		client.setQueryData<ConversationSummary | null>(queryKey, adoptConversation(client, conversation, conversation.id));
	};
	if (boxVersionsBuilt(conversation)) publish();
	else void loadBoxVersions(conversation).then(publish);
};

export const conversationQuery = (client: QueryClient, id: number, owner?: AbortSignal) => ({
	queryKey: conversationKey(id),
	staleTime: Infinity,
	refetchOnReconnect: false,
	refetchOnWindowFocus: "always" as const,
	queryFn: async ({ signal }: { signal: AbortSignal }) => {
		const incoming = await cancellableFetch(signal, owner, (cancellation) => loadConversation(id, cancellation));
		if (incoming !== null) await loadBoxVersions(incoming);
		return adoptConversation(client, incoming, id);
	},
});

export function useConversationQuery(id: number | null) {
	const client = useQueryClient();
	return useQuery(id === null ? { queryKey: conversationKey(id), queryFn: skipToken } : conversationQuery(client, id));
}
