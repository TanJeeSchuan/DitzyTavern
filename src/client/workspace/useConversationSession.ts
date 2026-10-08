import { useCallback, useRef, useState, type Dispatch } from "react";
import { loadHistoryPage } from "../chat-history";
import {
	loadConversation,
	type ConversationSummary,
} from "../conversation";
import { reduceStory, type StoryAction, type StoryState } from "../story";
import type { ChatSummary, Workspace } from "../workspace";
import { useAsyncEffect } from "../lib/use-async";
import { adoptConversationSummary } from "./conversation-session-state";
import { NetworkError } from "../lib/request-outcome";
import { api } from "../lib/eden";
import { decodeWirePayload } from "../lib/wire-decode";
import { chatHistoryPage } from "../../shared/contract/conversation-schema";
import { notFoundOutcome } from "../../shared/contract/outcomes";

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
	const storyRef = useRef(story);
	storyRef.current = story;
	const navigationRef = useRef(0);
	const pagingRef = useRef(false);
	const navigatingRef = useRef(false);
	const applyStory = useCallback((action: StoryAction) => {
		storyRef.current = reduceStory(storyRef.current, action);
		dispatchStory(action);
	}, [dispatchStory]);
	const [activeChatId, setActiveChatId] = useState(initialWorkspace.activeChat.id);
	const [conversation, setConversationState] = useState<ConversationSummary | null>(null);
	const conversationRef = useRef(conversation);
	conversationRef.current = conversation;
	const activeChatIdRef = useRef(activeChatId);
	activeChatIdRef.current = activeChatId;
	const setConversation = useCallback((next: ConversationSummary | null) => {
		conversationRef.current = adoptConversationSummary(conversationRef.current, next, activeChatIdRef.current);
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
			loadHistoryPage(conversationId, { page: 1 }),
		]).then(([loaded, outcome]) => {
			if (isCancelled()) return;
			setConversation(loaded);
			if (outcome.outcome === "available") {
				dispatchStory({
					type: "first-page",
					page: outcome.value,
					activeGenerationIds: loaded?.activeGenerations.map(({ generationId }) => generationId),
				});
			} else {
				dispatchStory({ type: "history-failed" });
			}
		});
	}, [activeChatId, dispatchStory]);

	const selectChat = (chatId: string) => {
		navigationRef.current += 1;
		navigatingRef.current = false;
		activeChatIdRef.current = chatId;
		setActiveChatId(chatId);
	};

	const afterRender = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));

	const loadMoreHistory = async (direction: "older" | "newer" = "older") => {
		const current = storyRef.current;
		const conversationId = current.conversationId;
		const edge = direction === "older" ? current.messages[0] : current.messages.at(-1);
		if (conversationId === null || !edge || (current.status !== "ready" && current.status !== "error") || pagingRef.current || navigatingRef.current ||
			!(direction === "older" ? current.page?.hasOlder : current.page?.hasNewer)) return;
		const navigation = navigationRef.current;
		pagingRef.current = true;
		applyStory({ type: "load-more-started" });
		try {
			const anchor = await loadHistoryPage(conversationId, { aroundMessageId: edge.id });
			if (navigation !== navigationRef.current) return;
			if (anchor.outcome !== "available") { applyStory({ type: "history-failed" }); return; }
			const extendsWindow = anchor.value.messages.some((message) => direction === "older" ? message.position < edge.position : message.position > edge.position);
			const outcome = extendsWindow ? anchor : await loadHistoryPage(conversationId, {
				page: anchor.value.page.index + (direction === "older" ? 1 : -1),
			});
			if (navigation !== navigationRef.current) return;
			if (outcome.outcome === "available") applyStory({ type: "next-page-arrived", page: outcome.value });
			else applyStory({ type: "history-failed" });
		} catch {
			if (navigation === navigationRef.current) applyStory({ type: "history-failed" });
		} finally { pagingRef.current = false; }
	};

	const navigateToSourceMessage = async (messageId: number) => {
		const conversationId = storyRef.current.conversationId;
		if (conversationId === null) return;
		const loaded = storyRef.current.messages.some((message) => message.id === messageId);
		const navigation = loaded ? navigationRef.current : ++navigationRef.current;
		navigatingRef.current = true;
		try {
			if (!loaded) {
				const outcome = await loadHistoryPage(conversationId, { aroundMessageId: messageId });
				if (navigation !== navigationRef.current) return;
				if (outcome.outcome !== "available") { applyStory({ type: "history-failed" }); return; }
				applyStory({ type: "first-page", page: outcome.value, activeGenerationIds: conversationRef.current?.activeGenerations.map(({ generationId }) => generationId) });
			}
			await afterRender();
			if (navigation !== navigationRef.current) return;
			document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)?.scrollIntoView({ behavior: "instant", block: "center" });
			await afterRender();
		} finally { if (navigation === navigationRef.current) navigatingRef.current = false; }
	};

	const refreshStory = useCallback(async (conversationId: number, signal?: AbortSignal) => {
		const current = storyRef.current;
		const navigation = navigationRef.current;
		const detached = current.page?.hasNewer === true;
		const freshConversation = await loadConversation(conversationId, signal);
		if (signal?.aborted || Number(activeChatIdRef.current) !== conversationId) return freshConversation;
		const requests = detached
			? current.messages.filter((_, index) => index % current.page!.pageSize === 0 || index === current.messages.length - 1).map((message) => ({ aroundMessageId: message.id }))
			: [{ page: 1 }];
		for (const request of requests) {
			const { data, error, response } = await api.api.conversations({ id: conversationId }).history.get({ query: request, fetch: { signal } });
			if (signal?.aborted || navigation !== navigationRef.current || Number(activeChatIdRef.current) !== conversationId) return freshConversation;
			if (error) {
				if (response === undefined) throw new NetworkError(`Unable to load Conversation ${conversationId} history`);
				if (error.status === 404 && decodeWirePayload(notFoundOutcome, error.value) !== null) continue;
				throw new Error(`Unable to load Conversation ${conversationId} history`);
			}
			const history = decodeWirePayload(chatHistoryPage, data);
			if (history === null) throw new Error(`Unable to load Conversation ${conversationId} history`);
			applyStory({
				type: detached ? "history-refreshed" : "first-page",
				page: history,
				activeGenerationIds: freshConversation?.activeGenerations.map(({ generationId }) => generationId),
			});
		}
		if (freshConversation !== null) setConversation(freshConversation);
		return freshConversation;
	}, [applyStory, setConversation]);

	const jumpToLatest = async () => {
		const conversationId = storyRef.current.conversationId;
		if (conversationId === null) throw new Error("No Chat is open.");
		const navigation = ++navigationRef.current;
		navigatingRef.current = true;
		try {
			const [loaded, outcome] = await Promise.all([
				loadConversation(conversationId),
				loadHistoryPage(conversationId, { page: 1 }),
			]);
			if (navigation !== navigationRef.current || loaded === null || outcome.outcome !== "available") throw new Error("The latest Messages could not be loaded.");
			setConversation(loaded);
			applyStory({ type: "first-page", page: outcome.value, activeGenerationIds: loaded.activeGenerations.map(({ generationId }) => generationId) });
			await afterRender();
			if (navigation !== navigationRef.current) throw new Error("The Chat changed.");
			const root = document.querySelector<HTMLElement>(".story-scroll");
			root?.scrollTo({ top: root.scrollHeight, behavior: "instant" });
			return loaded;
		} finally { if (navigation === navigationRef.current) navigatingRef.current = false; }
	};

	const ensureLatest = async () => storyRef.current.page?.hasNewer ? jumpToLatest() : conversationRef.current;

	return {
		activeChatId,
		activeChat,
		conversation,
		setConversation,
		activeChatIdRef,
		selectChat,
		loadMoreHistory,
		jumpToLatest,
		ensureLatest,
		navigateToSourceMessage,
		refreshStory,
	};
}
