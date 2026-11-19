import { createStoryOverlays, isStoryReady, readStory, reduceStoryOverlays, retireStoryOverlays, toStoryMessage, type StoryAction, type StoryWindow } from "../story";
import { infiniteQueryOptions, useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { loadHistoryPage, type ChatHistoryPageRequest } from "../chat-history";
import type { ConversationSummary } from "../conversation";
import { cancellableFetch, conversationKey, conversationQuery, publishConversation, useConversationQuery } from "../conversation-query";
import { workspaceQuery } from "../workspace";
import { NetworkError, SERVER_UNREACHABLE_NOTICE } from "../lib/request-outcome";
import { useVisitSignal } from "../lib/visit";

type HistoryAnchor = "latest" | { aroundMessageId: number };
type HistoryOutcome = Awaited<ReturnType<typeof loadHistoryPage>>;
type HistoryPageParam = ChatHistoryPageRequest & { revision?: number };
type HistoryData = InfiniteData<HistoryOutcome, HistoryPageParam>;
class SupersededHistory extends Error {}
const HISTORY_REFRESH_ATTEMPTS = 3;

const historyKey = (id: number) => ["conversation-history", id] as const;
const initialRequest = (anchor: HistoryAnchor): HistoryPageParam => anchor === "latest" ? { page: 1 } : anchor;

function selectHistoryWindow({ pages }: HistoryData) {
	const first = pages[0];
	const last = pages.at(-1);
	if (first?.outcome !== "available" || last?.outcome !== "available") return null;
	const rows = new Map(pages.flatMap((page) => page.outcome === "available" ? page.value.messages : []).map((message) => [message.id, message]));
	// @approved
	// Key by Message so structural sharing retains existing rows when a page prepends.
	const messages = Object.fromEntries([...rows].map(([id, message]) => [id, toStoryMessage(message)] as const));
	return { revision: first.value.revision, page: { ...last.value.page, hasNewer: first.value.page.hasNewer }, messages };
}

const historyQuery = (id: number, anchor: HistoryAnchor) => infiniteQueryOptions({
	queryKey: [...historyKey(id), anchor],
	initialPageParam: initialRequest(anchor),
	staleTime: Infinity,
	refetchOnReconnect: false,
	getNextPageParam: (last: HistoryOutcome) => last.outcome === "available" && last.value.page.hasOlder
		? { page: last.value.page.index + 1, revision: last.value.revision } : undefined,
	getPreviousPageParam: (first: HistoryOutcome) => first.outcome === "available" && first.value.page.hasNewer
		? { page: first.value.page.index - 1 } : undefined,
	queryFn: async ({ client, queryKey, signal, pageParam, direction }) => {
		const read = (request: ChatHistoryPageRequest) => cancellableFetch(signal, undefined, (cancellation) => loadHistoryPage(id, request, cancellation));
		let outcome = await read(pageParam);
		if (outcome.outcome === "not-found" && pageParam.aroundMessageId !== undefined) outcome = await read({ page: 1 });

		const cached = client.getQueryData<HistoryData>(queryKey)?.pages[0];
		const cachedRevision = cached?.outcome === "available" ? cached.value.revision : undefined;
		const expectedRevision = direction === "backward" ? cachedRevision : pageParam.revision;
		if (outcome.outcome === "available") {
			const authority = await client.ensureQueryData(conversationQuery(client, id));
			signal.throwIfAborted();
			const minimumRevision = () => Math.max(client.getQueryData<ConversationSummary | null>(conversationKey(id))?.revision ?? authority?.revision ?? 0, cachedRevision ?? 0);
			if (cached === undefined && outcome.value.revision < minimumRevision()) outcome = await read(pageParam);
			if (outcome.outcome === "available" && (
				outcome.value.revision < minimumRevision() || (expectedRevision !== undefined && outcome.value.revision !== expectedRevision)
			)) throw new SupersededHistory();
		}
		if (outcome.outcome === "not-found" && expectedRevision !== undefined) throw new SupersededHistory();

		if (outcome.outcome === "network") throw new NetworkError(SERVER_UNREACHABLE_NOTICE);
		if (outcome.outcome === "unusable") throw new Error(outcome.reason);
		return outcome;
	},
});
const afterRender = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));

/** @approved Coordinates the selected Chat's authoritative snapshot and paginated reading history. */
export function useConversationSession({ initialChatId }: { initialChatId: string }) {
	const client = useQueryClient();
	// @approved
	//  Each selection is a new visit, even when a batch returns to the same Chat.
	const [{ activeChatId, visit }, setSelection] = useState({ activeChatId: initialChatId, visit: 0 });
	const signal = useVisitSignal(visit);
	// @approved
	// A jump within the window supersedes the scroll and paging. Only replacing the window aborts its refresh.
	const navigation = useRef({ jump: new AbortController(), window: new AbortController(), navigating: false });
	const [anchor, setAnchor] = useState<HistoryAnchor>("latest");
	const [failedJump, setFailedJump] = useState<AbortSignal | null>(null);
	const pendingMessage = useRef<number | null>(null);
	const activeChatIdRef = useRef(activeChatId);
	const id = Number(activeChatId);
	const conversationId = Number.isInteger(id) && id > 0 ? id : null;
	const currentSession = useEffectEvent(() => ({ signal, story }));
	const conversationRead = useConversationQuery(conversationId);
	const history = useInfiniteQuery({ ...historyQuery(id, anchor), enabled: conversationId !== null, select: selectHistoryWindow });
	const [overlays, setOverlays] = useState(createStoryOverlays);
	const dispatchStory = useCallback((action: StoryAction) => setOverlays((current) => reduceStoryOverlays(current, action)), []);
	const conversation = conversationRead.data ?? null;
	const setConversation = useCallback((next: ConversationSummary | null) => {
		if (signal.aborted || Number(activeChatIdRef.current) !== conversationId) return;
		if (next !== null && next.id === conversationId) publishConversation(client, next);
		else if (next === null) client.setQueryData(conversationKey(conversationId), null);
	}, [client, conversationId, signal]);

	const selected = history.data;
	const historyWindow = useMemo<StoryWindow | null>(() => selected == null ? null : {
		revision: selected.revision, page: selected.page, messages: Object.values(selected.messages).sort((a, b) => a.position - b.position),
	}, [selected]);
	const visibleWindow = conversationRead.data !== undefined && (history.isFetchedAfterMount || (historyWindow?.revision ?? 0) >= (conversation?.revision ?? 0))
		? historyWindow : null;
	const currentOverlays = visibleWindow === null ? overlays : retireStoryOverlays(overlays, visibleWindow, conversation);
	if (currentOverlays !== overlays) setOverlays(currentOverlays);
	const historyFailed = history.data === null || (history.isError && !(history.error instanceof SupersededHistory && visibleWindow !== null));
	const story = readStory({
		overlays: currentOverlays,
		window: visibleWindow,
		conversationId,
		historyFailed: historyFailed || (failedJump !== null && !failedJump.aborted),
		loadingMore: history.isFetchingNextPage || history.isFetchingPreviousPage,
	});

	const workspace = useQuery({ ...workspaceQuery, enabled: false }).data;
	const activeChatTitle = conversation?.name ?? workspace?.chats.find((chat) => chat.id === activeChatId)?.title ?? "Chat";
	const selectChat = (chatId: string, messageId: number | null = null) => {
		if (chatId === activeChatIdRef.current) return;
		navigation.current.jump.abort();
		navigation.current.window.abort();
		navigation.current = { jump: new AbortController(), window: new AbortController(), navigating: false };
		void client.cancelQueries({ queryKey: historyKey(id) });
		void client.invalidateQueries({ queryKey: conversationKey(Number(chatId)) });
		void client.invalidateQueries({ queryKey: historyKey(Number(chatId)) });
		activeChatIdRef.current = chatId;
		pendingMessage.current = messageId;
		setAnchor(messageId === null ? "latest" : { aroundMessageId: messageId });
		setOverlays(createStoryOverlays());
		setSelection((current) => ({ activeChatId: chatId, visit: current.visit + 1 }));
	};

	const loadMoreHistory = async (direction: "older" | "newer" = "older") => {
		if (history.isFetching || navigation.current.navigating || signal.aborted || !(direction === "older" ? history.hasNextPage : history.hasPreviousPage)) return;
		const fetchPage = direction === "older" ? history.fetchNextPage : history.fetchPreviousPage;
		const pageSignal = navigation.current.jump.signal;
		const result = await fetchPage({ cancelRefetch: false });
		if (result.isSuccess && !pageSignal.aborted) setFailedJump(null);
		if (result.error instanceof SupersededHistory && !pageSignal.aborted) await history.refetch({ cancelRefetch: false });
	};

	const beginNavigation = (replaceWindow: boolean) => {
		const previous = navigation.current;
		previous.jump.abort();
		if (replaceWindow) previous.window.abort();
		void client.cancelQueries({
			queryKey: historyKey(id),
			predicate: (query) => replaceWindow || !query.isActive() || query.state.fetchMeta?.fetchMore !== undefined,
		});
		navigation.current = { jump: new AbortController(), window: replaceWindow ? new AbortController() : previous.window, navigating: true };
		return AbortSignal.any([signal, navigation.current.jump.signal]);
	};
	const openAnchor = async (next: HistoryAnchor, signal: AbortSignal) => {
		client.removeQueries({ queryKey: historyQuery(id, next).queryKey, exact: true });
		const result = await client.fetchInfiniteQuery(historyQuery(id, next));
		signal.throwIfAborted();
		if (result.pages[0]?.outcome !== "available") throw new Error("The Chat history could not be loaded.");
		setAnchor(next);
	};
	const navigateToSourceMessage = async (messageId: number) => {
		const current = currentSession().story;
		if (!isStoryReady(current) || signal.aborted) return;
		const replaceWindow = !current.messages.some((message) => message.id === messageId);
		const navigationSignal = beginNavigation(replaceWindow);
		try {
			if (replaceWindow) await openAnchor({ aroundMessageId: messageId }, navigationSignal);
			await afterRender();
			navigationSignal.throwIfAborted();
			document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)?.scrollIntoView({ behavior: "instant", block: "center" });
			await afterRender();
		} catch (error) { if (!navigationSignal.aborted) throw error; }
		finally { if (!navigationSignal.aborted) navigation.current.navigating = false; }
	};
	useEffect(() => {
		const messageId = pendingMessage.current;
		if (messageId === null || story.status !== "ready" || !story.messages.some((message) => message.id === messageId)) return;
		pendingMessage.current = null;
		void afterRender().then(() => {
			if (!signal.aborted) document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)?.scrollIntoView({ behavior: "instant", block: "center" });
		});
	}, [story.status, story.messages, signal]);

	const refreshStory = useCallback(async (id: number, external?: AbortSignal) => {
		const refresh = AbortSignal.any([currentSession().signal, ...(external ? [external] : []), navigation.current.window.signal]);
		refresh.throwIfAborted();
		await client.cancelQueries({ queryKey: conversationKey(id) });
		const freshConversation = await client.fetchQuery({ ...conversationQuery(client, id, refresh), staleTime: 0 });
		for (let attempt = 1; ; attempt++) {
			refresh.throwIfAborted();
			try {
				await client.refetchQueries({ queryKey: historyKey(id), type: "active" }, { cancelRefetch: false, throwOnError: true });
				break;
			} catch (error) {
				if (!(error instanceof SupersededHistory) || attempt === HISTORY_REFRESH_ATTEMPTS) throw error;
			}
		}
		refresh.throwIfAborted();
		return freshConversation;
	}, [client]);

	const jumpToLatest = async () => {
		if (signal.aborted || !isStoryReady(currentSession().story)) return null;
		const navigationSignal = beginNavigation(true);
		try {
			await client.cancelQueries({ queryKey: conversationKey(id) });
			const loaded = await client.fetchQuery({ ...conversationQuery(client, id, navigationSignal), staleTime: 0 });
			await openAnchor("latest", navigationSignal);
			await afterRender();
			navigationSignal.throwIfAborted();
			const root = document.querySelector<HTMLElement>(".story-scroll");
			root?.scrollTo({ top: root.scrollHeight, behavior: "instant" });
			return loaded;
		} catch (error) {
			if (!navigationSignal.aborted) setFailedJump(navigationSignal);
			throw error;
		} finally { if (!navigationSignal.aborted) navigation.current.navigating = false; }
	};
	const ensureLatest = async () => {
		if (signal.aborted) return null;
		const current = currentSession().story;
		return isStoryReady(current) && current.page.hasNewer ? jumpToLatest() : client.getQueryData<ConversationSummary | null>(conversationKey(id)) ?? null;
	};

	return {
		signal, activeChatId, activeChatTitle, conversation, setConversation, activeChatIdRef, story, dispatchStory,
		selectChat, loadMoreHistory, jumpToLatest, ensureLatest, navigateToSourceMessage, refreshStory,
	};
}
