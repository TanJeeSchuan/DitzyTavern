import { skipToken, useQuery, useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";
import { loadConversationGenerationSettings, type ConversationGenerationSettings, type ConversationSummary } from "./conversation";
import { foldNewer } from "./lib/visit";

interface SettingsRead { revision: number; settings: ConversationGenerationSettings }
export const generationSettingsKey = (conversationId: number | null) => ["generation-settings", conversationId] as const;

export const publishGenerationSettings = (client: QueryClient, conversation: ConversationSummary, settings: ConversationGenerationSettings) =>
	foldNewer<SettingsRead>(client, generationSettingsKey(conversation.id), { revision: conversation.revision, settings }, (read) => read.revision);

export function useGenerationSettingsQuery(conversation: ConversationSummary | null) {
	const client = useQueryClient();
	return useQuery({
		queryKey: generationSettingsKey(conversation?.id ?? null),
		staleTime: (query: Query<SettingsRead>) => (query.state.data?.revision ?? 0) < (conversation?.revision ?? 0) ? 0 : Infinity,
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
