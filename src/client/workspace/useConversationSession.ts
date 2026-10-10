import { infiniteQueryOptions, useInfiniteQuery, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useEffectEvent, useRef, useState, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { loadHistoryPage, type ChatHistoryPageRequest } from "../chat-history";
import type { ConversationSummary } from "../conversation";
import { cancellableFetch, conversationKey, conversationQuery, publishConversation, useConversationQuery } from "../conversation-query";
import type { StoryAction, StoryState } from "../story";
import type { ChatSummary, Workspace } from "../workspace";
import { NetworkError, SERVER_UNREACHABLE_NOTICE } from "../lib/request-outcome";

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
const selection = (activeChatId: string) => ({ activeChatId, owner: { cancellation: new AbortController(), window: new AbortController(), navigating: false } });
const afterRender = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));

/** @approved Coordinates the selected Chat's authoritative snapshot and paginated reading history. */
export function useConversationSession({ initialWorkspace, story, dispatchStory }: ConversationSessionOptions) {
	const client = useQueryClient();
	const [{ activeChatId, owner }, setSelection] = useState(() => selection(initialWorkspace.activeChat.id));
	const [anchor, setAnchor] = useState<HistoryAnchor>("latest");
	const activeChatIdRef = useRef(activeChatId);
	const id = Number(activeChatId);
	const conversationId = Number.isInteger(id) && id > 0 ? id : null;
	const currentSession = useEffectEvent(() => ({ story, owner }));
	const conversationRead = useConversationQuery(conversationId);
	const history = useInfiniteQuery({ ...historyQuery(id, anchor), enabled: conversationId !== null });
	const conversation = conversationRead.data ?? null;
	const setConversation = useCallback((next: ConversationSummary | null) => {
		if (owner.cancellation.signal.aborted || Number(activeChatIdRef.current) !== conversationId) return;
		if (next !== null && next.id === conversationId) publishConversation(client, next);
		else if (next === null) client.setQueryData(conversationKey(conversationId), null);
	}, [client, conversationId, owner]);

	useEffect(() => {
		if (owner.cancellation.signal.aborted) { owner.cancellation = new AbortController(); owner.window = new AbortController(); }
		if (conversationId !== null) dispatchStory({ type: "chat-opened", conversationId });
		return () => { owner.cancellation.abort(); owner.window.abort(); };
	}, [conversationId, owner, dispatchStory]);

	const receiveWindow = useCallback((data: InfiniteData<HistoryOutcome>) => {
		const pages = data.pages.flatMap((outcome) => outcome.outcome === "available" ? [outcome.value] : []);
		const first = pages[0];
		const last = pages.at(-1);
		if (!first || !last) return;
		const authority = client.getQueryData<ConversationSummary | null>(conversationKey(id));
		const revision = Math.min(...pages.map((page) => page.revision));
		if (owner.cancellation.signal.aborted || revision < (authority?.revision ?? 0)) return;
		dispatchStory({
			type: "window-received",
			page: { ...first, revision,
				messages: [...new Map(pages.flatMap((page) => page.messages).map((message) => [message.id, message])).values()].sort((a, b) => a.position - b.position),
				page: { ...last.page, hasNewer: first.page.hasNewer },
			},
			activeGenerationIds: authority?.activeGenerations.map(({ generationId }) => generationId),
		});
	}, [client, id, owner, dispatchStory]);

	useEffect(() => {
		if (owner.cancellation.signal.aborted || conversationRead.data === undefined || history.isFetching) return;
		if (history.isError) { dispatchStory({ type: "history-failed" }); return; }
		if (!history.data) return;
		if (history.data.pages.some((page) => page.outcome === "not-found")) {
			if (anchor !== "latest") setAnchor("latest");
			else dispatchStory({ type: "history-failed" });
			return;
		}

		receiveWindow(history.data);
	}, [conversationRead.data, conversation, history.data, history.isFetching, history.isError, anchor, owner, dispatchStory, receiveWindow]);

	useEffect(() => {
		if (history.data?.pages.some((page) => page.outcome === "available" && page.value.revision < (conversation?.revision ?? 0))) void history.refetch({ cancelRefetch: false });
	}, [history.data, conversation, history.refetch]);

	const listedChat = initialWorkspace.chats.find((chat) => chat.id === activeChatId) ?? initialWorkspace.activeChat;
	const activeChat = conversation !== null && String(conversation.id) === listedChat.id ? { ...listedChat, title: conversation.name } : listedChat;
	const selectChat = (chatId: string) => {
		if (chatId === activeChatIdRef.current) return;
		owner.cancellation.abort();
		owner.window.abort();
		void client.cancelQueries({ queryKey: historyKey(id) });
		void client.invalidateQueries({ queryKey: conversationKey(Number(chatId)) });
		void client.invalidateQueries({ queryKey: historyKey(Number(chatId)) });
		activeChatIdRef.current = chatId;
		setAnchor("latest");
		setSelection(selection(chatId));
	};

	const loadMoreHistory = async (direction: "older" | "newer" = "older") => {
		if (history.isFetching || owner.navigating || owner.cancellation.signal.aborted || !(direction === "older" ? history.hasNextPage : history.hasPreviousPage)) return;
		dispatchStory({ type: "load-more-started" });
		await (direction === "older" ? history.fetchNextPage({ cancelRefetch: false }) : history.fetchPreviousPage({ cancelRefetch: false }));
	};

	const beginNavigation = () => {
		owner.window.abort();
		void client.cancelQueries({ queryKey: historyKey(id) });
		owner.window = new AbortController();
		owner.navigating = true;
		dispatchStory({ type: "paging-cancelled" });
		return AbortSignal.any([owner.cancellation.signal, owner.window.signal]);
	};
	const openAnchor = async (next: HistoryAnchor, signal: AbortSignal) => {
		const data = await client.fetchInfiniteQuery({ ...historyQuery(id, next), staleTime: 0 });
		signal.throwIfAborted();
		flushSync(() => { setAnchor(next); receiveWindow(data); });
	};
	const navigateToSourceMessage = async (messageId: number) => {
		const current = currentSession().story;
		if (current.conversationId === null || owner.cancellation.signal.aborted) return;
		const signal = beginNavigation();
		try {
			if (!current.messages.some((message) => message.id === messageId)) await openAnchor({ aroundMessageId: messageId }, signal);
			await afterRender();
			signal.throwIfAborted();
			document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)?.scrollIntoView({ behavior: "instant", block: "center" });
			await afterRender();
		} catch (error) { if (!signal.aborted) throw error; }
		finally { if (!signal.aborted) owner.navigating = false; }
	};

	const refreshStory = useCallback(async (id: number, external?: AbortSignal) => {
		const { owner } = currentSession();
		const signal = AbortSignal.any([owner.cancellation.signal, ...(external ? [external] : []), owner.window.signal]);
		signal.throwIfAborted();
		await client.cancelQueries({ queryKey: conversationKey(id) });
		const freshConversation = await client.fetchQuery({ ...conversationQuery(client, id, signal), staleTime: 0 });
		signal.throwIfAborted();
		await client.refetchQueries({ queryKey: historyKey(id), type: "active" }, { cancelRefetch: false, throwOnError: true });
		signal.throwIfAborted();
		return freshConversation;
	}, [client]);

	const jumpToLatest = async () => {
		if (currentSession().story.conversationId === null) throw new Error("No Chat is open.");
		const signal = beginNavigation();
		try {
			await client.cancelQueries({ queryKey: conversationKey(id) });
			const loaded = await client.fetchQuery({ ...conversationQuery(client, id, signal), staleTime: 0 });
			await openAnchor("latest", signal);
			await afterRender();
			signal.throwIfAborted();
			const root = document.querySelector<HTMLElement>(".story-scroll");
			root?.scrollTo({ top: root.scrollHeight, behavior: "instant" });
			return loaded;
		} finally { if (!signal.aborted) owner.navigating = false; }
	};
	const ensureLatest = async () => currentSession().story.page?.hasNewer ? jumpToLatest() : client.getQueryData<ConversationSummary | null>(conversationKey(id)) ?? null;

	return {
		signal: owner.cancellation.signal, activeChatId, activeChat, conversation, setConversation, activeChatIdRef,
		selectChat, loadMoreHistory, jumpToLatest, ensureLatest, navigateToSourceMessage, refreshStory,
	};
}
