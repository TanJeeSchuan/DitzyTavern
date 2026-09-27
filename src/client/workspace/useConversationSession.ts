import { useCallback, useRef, useState, type Dispatch } from "react";
import { chatHistoryTransport } from "../chat-history";
import {
	loadConversation,
	type ConversationSummary,
} from "../conversation";
import type { StoryAction, StoryState } from "../story";
import type { ChatSummary, Workspace } from "../workspace";
import { useAsyncEffect } from "../lib/use-async";
import { adoptConversationSummary } from "./conversation-session-state";

type ConversationSessionOptions = {
	initialWorkspace: Workspace & { activeChat: ChatSummary };
	story: StoryState;
	dispatchStory: Dispatch<StoryAction>;
};

/**
 * ==[HUMAN APPROVED]== Coordinates the selected Chat's authoritative snapshot and paginated
 * reading history. Conversation state and the story read model are loaded
 * together here so every caller observes the same Chat boundary.
 */
export function useConversationSession({
	initialWorkspace,
	story,
	dispatchStory,
}: ConversationSessionOptions) {
	const [activeChatId, setActiveChatId] = useState(initialWorkspace.activeChat.id);
	const [conversation, setConversationState] = useState<ConversationSummary | null>(null);
	const activeChatIdRef = useRef(activeChatId);
	activeChatIdRef.current = activeChatId;
	const setConversation = useCallback((next: ConversationSummary | null) => {
		setConversationState((current) => {
			return adoptConversationSummary(current, next, activeChatIdRef.current);
		});
	}, []);

	const listedChat =
		initialWorkspace.chats.find((chat) => chat.id === activeChatId) ??
		initialWorkspace.activeChat;
	const activeChat = conversation !== null && String(conversation.id) === listedChat.id
		? { ...listedChat, title: conversation.name }
		: listedChat;

	useAsyncEffect((isCancelled) => {
		setConversationState(null);
		const conversationId = Number(activeChatId);
		if (!Number.isInteger(conversationId) || conversationId <= 0) return;

		dispatchStory({ type: "chat-opened", conversationId });
		void Promise.all([
			loadConversation(conversationId),
			chatHistoryTransport.loadHistory(conversationId, { page: 1 }),
		]).then(([loaded, outcome]) => {
			if (isCancelled()) return;
			setConversation(loaded);
			if (outcome.status === "available") {
				dispatchStory({
					type: "first-page",
					page: outcome.page,
					activeGenerationIds: loaded?.activeGenerations.map(({ generationId }) => generationId),
				});
			} else {
				dispatchStory({ type: "history-failed" });
			}
		});
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

	const navigateToSourceMessage = async (messageId: number) => {
		const scroll = () => document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
		if (document.querySelector(`[data-message-id="${messageId}"]`)) {
			scroll();
			return;
		}
		const conversationId = story.conversationId;
		let page = story.page;
		while (conversationId !== null && page?.hasOlder) {
			if (Number(activeChatIdRef.current) !== conversationId) return;
			const outcome = await chatHistoryTransport.loadHistory(conversationId, { page: page.index + 1 });
			if (outcome.status !== "available") return;
			dispatchStory({ type: "next-page-arrived", page: outcome.page });
			page = outcome.page.page;
			if (outcome.page.messages.some((message) => message.id === messageId)) {
				await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));
				if (Number(activeChatIdRef.current) === conversationId) scroll();
				return;
			}
		}
	};

	const refreshStory = useCallback(async (conversationId: number) => {
		const [freshConversation, freshHistory] = await Promise.all([
			loadConversation(conversationId),
			chatHistoryTransport.loadHistory(conversationId, { page: 1 }),
		]);
		if (Number(activeChatIdRef.current) !== conversationId) return freshConversation;
		if (freshConversation !== null) setConversation(freshConversation);
		if (freshHistory.status === "available") {
			dispatchStory({
				type: "first-page",
				page: freshHistory.page,
				activeGenerationIds: freshConversation?.activeGenerations.map(({ generationId }) => generationId),
			});
		}
		return freshConversation;
	}, [dispatchStory]);

	return {
		activeChatId,
		activeChat,
		conversation,
		setConversation,
		activeChatIdRef,
		selectChat,
		loadMoreHistory,
		navigateToSourceMessage,
		refreshStory,
	};
}
