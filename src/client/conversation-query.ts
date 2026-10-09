import { skipToken, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { loadConversation, type ConversationSummary } from "./conversation";
import { adoptConversationSummary } from "./workspace/conversation-session-state";

export const conversationKey = (id: number | null) => ["conversation", id] as const;

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
		const cancellation = owner ? AbortSignal.any([signal, owner]) : signal;
		await Promise.resolve();
		cancellation.throwIfAborted();
		const incoming = await loadConversation(id, cancellation);
		cancellation.throwIfAborted();
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
