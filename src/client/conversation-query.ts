import { skipToken, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { loadConversation, type ConversationSummary } from "./conversation";
import { adoptConversationSummary } from "./workspace/conversation-session-state";

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

export const publishConversation = (client: QueryClient, conversation: ConversationSummary) => {
	const queryKey = conversationKey(conversation.id);
	void client.cancelQueries({ queryKey });
	void client.invalidateQueries({ queryKey: ["conversation-history", conversation.id], refetchType: "none" });
	return client.setQueryData<ConversationSummary | null>(queryKey, (current) => adoptConversationSummary(current ?? null, conversation, conversation.id));
};

export const conversationQuery = (client: QueryClient, id: number, owner?: AbortSignal) => ({
	queryKey: conversationKey(id),
	staleTime: Infinity,
	refetchOnReconnect: false,
	queryFn: async ({ signal }: { signal: AbortSignal }) => {
		const incoming = await cancellableFetch(signal, owner, (cancellation) =>
			loadConversation(id, cancellation),
		);
		const current = client.getQueryData<ConversationSummary | null>(conversationKey(id)) ?? null;
		if (incoming !== null && incoming.revision > (current?.revision ?? 0)) {
			void client.invalidateQueries({ queryKey: ["conversation-history", id], refetchType: "none" });
		}
		return adoptConversationSummary(current, incoming, id);
	},
});

export function useConversationQuery(id: number | null) {
	const client = useQueryClient();
	return useQuery(id === null ? { queryKey: conversationKey(id), queryFn: skipToken } : conversationQuery(client, id));
}
