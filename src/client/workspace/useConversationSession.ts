import { useEffect, useRef, useState, type Dispatch } from "react";
import { chatHistoryTransport } from "../chat-history";
import {
	loadConversation,
	type ConversationSummary,
} from "../conversation";
import type { StoryAction, StoryState } from "../story";
import type { ChatSummary, Workspace } from "../workspace";

type ConversationSessionOptions = {
	initialWorkspace: Workspace & { activeChat: ChatSummary };
	story: StoryState;
	dispatchStory: Dispatch<StoryAction>;
};

/**
 * Coordinates the selected Chat's authoritative snapshot and paginated
 * reading history. Conversation state and the story read model are loaded
 * together here so every caller observes the same Chat boundary.
 */
export function useConversationSession({
	initialWorkspace,
	story,
	dispatchStory,
}: ConversationSessionOptions) {
	const [activeChatId, setActiveChatId] = useState(initialWorkspace.activeChat.id);
	const [conversation, setConversation] = useState<ConversationSummary | null>(null);
	const activeChatIdRef = useRef(activeChatId);
	activeChatIdRef.current = activeChatId;

	const activeChat =
		initialWorkspace.chats.find((chat) => chat.id === activeChatId) ??
		initialWorkspace.activeChat;

	useEffect(() => {
		setConversation(null);
		const conversationId = Number(activeChatId);
		if (!Number.isInteger(conversationId) || conversationId <= 0) return;

		let cancelled = false;
		loadConversation(conversationId)
			.then((loaded) => {
				if (!cancelled) setConversation(loaded);
			})
			.catch(() => {
				if (!cancelled) setConversation(null);
			});
		return () => {
			cancelled = true;
		};
	}, [activeChatId]);

	useEffect(() => {
		const conversationId = Number(activeChatId);
		if (!Number.isInteger(conversationId) || conversationId <= 0) return;

		dispatchStory({ type: "chat-opened", conversationId });
		let cancelled = false;
		void chatHistoryTransport.loadHistory(conversationId, { page: 1 }).then((outcome) => {
			if (cancelled) return;
			if (outcome.status === "available") {
				dispatchStory({ type: "first-page", page: outcome.page });
			} else {
				dispatchStory({ type: "history-failed" });
			}
		});
		return () => {
			cancelled = true;
		};
	}, [activeChatId, dispatchStory]);

	const selectChat = (chatId: string) => {
		activeChatIdRef.current = chatId;
		setActiveChatId(chatId);
	};

	const loadMoreHistory = async () => {
		const conversationId = story.conversationId;
		const next = (story.page?.index ?? 0) + 1;
		if (conversationId === null || story.page?.hasOlder !== true) return;

		dispatchStory({ type: "load-more-started" });
		const outcome = await chatHistoryTransport.loadHistory(conversationId, { page: next });
		if (outcome.status === "available") {
			dispatchStory({ type: "next-page-arrived", page: outcome.page });
		} else {
			dispatchStory({ type: "history-failed" });
		}
	};

	const refreshStory = async (conversationId: number) => {
		const [freshConversation, freshHistory] = await Promise.all([
			loadConversation(conversationId),
			chatHistoryTransport.loadHistory(conversationId, { page: 1 }),
		]);
		if (Number(activeChatIdRef.current) !== conversationId) return freshConversation;
		if (freshConversation !== null) setConversation(freshConversation);
		if (freshHistory.status === "available") {
			dispatchStory({ type: "first-page", page: freshHistory.page });
		}
		return freshConversation;
	};

	return {
		activeChatId,
		activeChat,
		conversation,
		setConversation,
		activeChatIdRef,
		selectChat,
		loadMoreHistory,
		refreshStory,
	};
}
