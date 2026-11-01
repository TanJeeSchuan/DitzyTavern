import { isStoryReady } from "../story";
import { infiniteQueryOptions, useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useCallback, useEffect, useEffectEvent, useRef, useState, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { loadHistoryPage, type ChatHistoryPageRequest } from "../chat-history";
import type { ConversationSummary } from "../conversation";
import { cancellableFetch, conversationKey, conversationQuery, publishConversation, useConversationQuery } from "../conversation-query";
import type { StoryAction, StoryState } from "../story";
import type { ChatSummary, Workspace } from "../workspace";
import { NetworkError, SERVER_UNREACHABLE_NOTICE } from "../lib/request-outcome";
import { useVisitSignal } from "../lib/visit";

type ConversationSessionOptions = {
	initialWorkspace: Workspace & { activeChat: ChatSummary };
	story: StoryState;
	dispatchStory: Dispatch<StoryAction>;
};

type HistoryAnchor = "latest" | { aroundMessageId: number };
type HistoryOutcome = Awaited<ReturnType<typeof loadHistoryPage>>;
const historyKey = (id: number) => ["conversation-history", id] as const;
const initialRequest = (anchor: HistoryAnchor): ChatHistoryPageRequest => anchor === "latest" ? { page: 1 } : anchor;
const historyQuery = (id: number, anchor: HistoryAnchor) => infiniteQueryOptions({
	queryKey: [...historyKey(id), anchor],
	initialPageParam: initialRequest(anchor),
	staleTime: Infinity,
	refetchOnReconnect: false,
	getNextPageParam: (last: HistoryOutcome) => last.outcome === "available" && last.value.page.hasOlder ? { page: last.value.page.index + 1 } : undefined,
	getPreviousPageParam: (first: HistoryOutcome) => first.outcome === "available" && first.value.page.hasNewer ? { page: first.value.page.index - 1 } : undefined,
	queryFn: async ({ signal, pageParam }) => {
		const outcome = await cancellableFetch(signal, undefined, (cancellation) => loadHistoryPage(id, pageParam, cancellation));
		if (outcome.outcome === "network") throw new NetworkError(SERVER_UNREACHABLE_NOTICE);
		if (outcome.outcome === "unusable") throw new Error(outcome.reason);
		return outcome;
	},
});
const afterRender = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));

/** @approved Coordinates the selected Chat's authoritative snapshot and paginated reading history. */
export function useConversationSession({ initialWorkspace, story, dispatchStory }: ConversationSessionOptions) {
	const client = useQueryClient();
	// @approved
	//  Each selection is a new visit, even when a batch returns to the same Chat.
	const [{ activeChatId, visit }, setSelection] = useState({ activeChatId: initialWorkspace.activeChat.id, visit: 0 });
	const signal = useVisitSignal(visit);
	// @approved
	//  The latest navigation within the visit: a newer one, or a Chat switch, aborts it.
	const navigation = useRef({ window: new AbortController(), navigating: false });
	const [anchor, setAnchor] = useState<HistoryAnchor>("latest");
	const pendingMessage = useRef<number | null>(null);
	const activeChatIdRef = useRef(activeChatId);
	const id = Number(activeChatId);
	const conversationId = Number.isInteger(id) && id > 0 ? id : null;
	const currentSession = useEffectEvent(() => ({ story, signal }));
	const conversationRead = useConversationQuery(conversationId);
	const history = useInfiniteQuery({ ...historyQuery(id, anchor), enabled: conversationId !== null });
	const conversation = conversationRead.data ?? null;
	const setConversation = useCallback((next: ConversationSummary | null) => {
		if (signal.aborted || Number(activeChatIdRef.current) !== conversationId) return;
		if (next !== null && next.id === conversationId) publishConversation(client, next);
		else if (next === null) client.setQueryData(conversationKey(conversationId), null);
	}, [client, conversationId, signal]);

	useEffect(() => {
		if (conversationId !== null) dispatchStory({ type: "chat-opened", conversationId });
	}, [visit, conversationId, dispatchStory]);

	const receiveWindow = useCallback((data: InfiniteData<HistoryOutcome>) => {
		const pages = data.pages.flatMap((outcome) => outcome.outcome === "available" ? [outcome.value] : []);
		const first = pages[0];
		const last = pages.at(-1);
		if (!first || !last) return;
		const authority = client.getQueryData<ConversationSummary | null>(conversationKey(id));
		const { revision } = first;
		if (signal.aborted || revision < (authority?.revision ?? 0) || pages.some((page) => page.revision !== revision)) return;
		dispatchStory({
			type: "window-received",
			page: { ...first, revision,
				messages: [...new Map(pages.flatMap((page) => page.messages).map((message) => [message.id, message])).values()].sort((a, b) => a.position - b.position),
				page: { ...last.page, hasNewer: first.page.hasNewer },
			},
			activeGenerationIds: authority?.activeGenerations.map(({ generationId }) => generationId),
		});
	}, [client, id, signal, dispatchStory]);

	useEffect(() => {
		if (signal.aborted || conversationRead.data === undefined || history.isFetching) return;
		if (history.isError) { dispatchStory({ type: "history-failed" }); return; }
		if (!history.data) return;
		if (history.data.pages.some((page) => page.outcome === "not-found")) {
			if (anchor !== "latest") setAnchor("latest");
			else dispatchStory({ type: "history-failed" });
			return;
		}

		receiveWindow(history.data);
	}, [conversationRead.data, conversation, history.data, history.isFetching, history.isError, anchor, signal, dispatchStory, receiveWindow]);

	useEffect(() => {
		const revisions = history.data?.pages.flatMap((page) => page.outcome === "available" ? [page.value.revision] : []) ?? [];
		if (new Set(revisions).size > 1 || revisions.some((revision) => revision < (conversation?.revision ?? 0))) void history.refetch({ cancelRefetch: false });
	}, [history.data, conversation, history.refetch]);

	const listedChat = initialWorkspace.chats.find((chat) => chat.id === activeChatId) ?? initialWorkspace.activeChat;
	const activeChat = conversation !== null && String(conversation.id) === activeChatId ? { ...listedChat, id: activeChatId, title: conversation.name } : { ...listedChat, id: activeChatId };
	const selectChat = (chatId: string, messageId: number | null = null) => {
		if (chatId === activeChatIdRef.current) return;
		navigation.current.window.abort();
		navigation.current = { window: new AbortController(), navigating: false };
		void client.cancelQueries({ queryKey: historyKey(id) });
		void client.invalidateQueries({ queryKey: conversationKey(Number(chatId)) });
		void client.invalidateQueries({ queryKey: historyKey(Number(chatId)) });
		activeChatIdRef.current = chatId;
		pendingMessage.current = messageId;
		setAnchor(messageId === null ? "latest" : { aroundMessageId: messageId });
		setSelection((current) => ({ activeChatId: chatId, visit: current.visit + 1 }));
	};

	const loadMoreHistory = async (direction: "older" | "newer" = "older") => {
		if (history.isFetching || navigation.current.navigating || signal.aborted || !(direction === "older" ? history.hasNextPage : history.hasPreviousPage)) return;
		dispatchStory({ type: "load-more-started" });
		await (direction === "older" ? history.fetchNextPage({ cancelRefetch: false }) : history.fetchPreviousPage({ cancelRefetch: false }));
	};

	const beginNavigation = () => {
		navigation.current.window.abort();
		void client.cancelQueries({ queryKey: historyKey(id) });
		navigation.current = { window: new AbortController(), navigating: true };
		dispatchStory({ type: "paging-cancelled" });
		return AbortSignal.any([signal, navigation.current.window.signal]);
	};
	const openAnchor = async (next: HistoryAnchor, signal: AbortSignal) => {
		client.removeQueries({ queryKey: historyQuery(id, next).queryKey, exact: true });
		const data = await client.fetchInfiniteQuery(historyQuery(id, next));
		signal.throwIfAborted();
		flushSync(() => { setAnchor(next); receiveWindow(data); });
	};
	const navigateToSourceMessage = async (messageId: number) => {
		const current = currentSession().story;
		if (!isStoryReady(current) || signal.aborted) return;
		const navigationSignal = beginNavigation();
		try {
			if (!current.messages.some((message) => message.id === messageId)) await openAnchor({ aroundMessageId: messageId }, navigationSignal);
			await afterRender();
			navigationSignal.throwIfAborted();
			document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)?.scrollIntoView({ behavior: "instant", block: "center" });
			await afterRender();
		} catch (error) { if (!navigationSignal.aborted) throw error; }
		finally { if (!navigationSignal.aborted) navigation.current.navigating = false; }
	};
	useEffect(() => {
		const messageId = pendingMessage.current;
		if (messageId === null || !isStoryReady(story) || story.conversationId !== conversationId || !story.messages.some((message) => message.id === messageId)) return;
		pendingMessage.current = null;
		void afterRender().then(() => {
			if (!signal.aborted) document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)?.scrollIntoView({ behavior: "instant", block: "center" });
		});
	}, [story, conversationId, signal]);

	const refreshStory = useCallback(async (id: number, external?: AbortSignal) => {
		const refresh = AbortSignal.any([currentSession().signal, ...(external ? [external] : []), navigation.current.window.signal]);
		refresh.throwIfAborted();
		await client.cancelQueries({ queryKey: conversationKey(id) });
		const freshConversation = await client.fetchQuery({ ...conversationQuery(client, id, refresh), staleTime: 0 });
		refresh.throwIfAborted();
		await client.refetchQueries({ queryKey: historyKey(id), type: "active" }, { cancelRefetch: false, throwOnError: true });
		refresh.throwIfAborted();
		return freshConversation;
	}, [client]);

	const jumpToLatest = async () => {
		if (!isStoryReady(currentSession().story)) return null;
		const navigationSignal = beginNavigation();
		try {
			await client.cancelQueries({ queryKey: conversationKey(id) });
			const loaded = await client.fetchQuery({ ...conversationQuery(client, id, navigationSignal), staleTime: 0 });
			await openAnchor("latest", navigationSignal);
			await afterRender();
			navigationSignal.throwIfAborted();
			const root = document.querySelector<HTMLElement>(".story-scroll");
			root?.scrollTo({ top: root.scrollHeight, behavior: "instant" });
			return loaded;
		} finally { if (!navigationSignal.aborted) navigation.current.navigating = false; }
	};
	const ensureLatest = async () => {
		const current = currentSession().story;
		return isStoryReady(current) && current.page.hasNewer ? jumpToLatest() : client.getQueryData<ConversationSummary | null>(conversationKey(id)) ?? null;
	};

	return {
		signal, activeChatId, activeChat, conversation, setConversation, activeChatIdRef,
		selectChat, loadMoreHistory, jumpToLatest, ensureLatest, navigateToSourceMessage, refreshStory,
	};
}
