import { skipToken, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { loadConversationGenerationSettings, type ConversationGenerationSettings, type ConversationSummary } from "./conversation";

interface SettingsRead { revision: number; settings: ConversationGenerationSettings }
export const generationSettingsKey = (conversationId: number | null) => ["generation-settings", conversationId] as const;

export const publishGenerationSettings = (client: QueryClient, conversation: ConversationSummary, settings: ConversationGenerationSettings) => {
	const queryKey = generationSettingsKey(conversation.id);
	void client.cancelQueries({ queryKey });
	return client.setQueryData<SettingsRead>(queryKey, (current) => current !== undefined && current.revision > conversation.revision
		? current : { revision: conversation.revision, settings });
};

export function useGenerationSettingsQuery(conversation: ConversationSummary | null) {
	const client = useQueryClient();
	return useQuery({
		queryKey: generationSettingsKey(conversation?.id ?? null),
		staleTime: Infinity,
		refetchOnReconnect: false,
		queryFn: conversation === null ? skipToken : async ({ signal }) => {
			await Promise.resolve();
			signal.throwIfAborted();
			const revision = Math.max(conversation.revision, client.getQueryData<SettingsRead>(generationSettingsKey(conversation.id))?.revision ?? 0);
			const settings = await loadConversationGenerationSettings(conversation.id, signal);
			signal.throwIfAborted();
			const current = client.getQueryData<SettingsRead>(generationSettingsKey(conversation.id));
			return current !== undefined && current.revision > revision ? current : { revision, settings };
		},
		select: (read) => read.settings,
	});
}
