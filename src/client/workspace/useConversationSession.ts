import { createStoryOverlays, isStoryReady, readStory, reduceStoryOverlays, retireStoryOverlays, toStoryMessage, type StoryAction, type StoryWindow } from "../story";
import { skipToken, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { loadHistoryPage, type ChatHistoryPage, type ChatHistoryPageRequest } from "../chat-history";
import type { ConversationSummary } from "../conversation";
import { cancellableFetch, conversationHistoryKey, conversationKey, conversationQuery, publishConversation, useConversationQuery } from "../conversation-query";
import { workspaceQuery } from "../workspace";
import { NetworkError, SERVER_UNREACHABLE_NOTICE } from "../lib/request-outcome";
import { useVisitSignal } from "../lib/visit";

type HistoryRead =
	| { kind: "refresh"; initial: ChatHistoryPageRequest }
	| { kind: "jump"; start: ChatHistoryPageRequest; refreshSummary: boolean }
	| { kind: "page"; direction: "older" | "newer" };

type HistorySnapshot = { start: ChatHistoryPageRequest; pages: [ChatHistoryPage, ...ChatHistoryPage[]] };
type Navigation = { jumps: Set<AbortController>; window: AbortController; paging: AbortController | null };
class SupersededHistory extends Error {}
const HISTORY_ATTEMPTS = 3;

const historyWindowKey = (id: number, visit: number) => ["history-window", id, visit] as const;
const historyRefreshKey = (id: number, visit: number) => [...conversationHistoryKey(id), visit] as const;

function selectHistoryWindow({ pages }: HistorySnapshot) {
	const [first] = pages;
	const last = pages.at(-1) ?? first;
	const rows = new Map(pages.flatMap((page) => page.messages.map((message) => [message.id, message] as const)));
	// @approved
	// Key by Message so structural sharing retains existing rows when a page prepends.
	const messages = Object.fromEntries([...rows].map(([id, message]) => [id, toStoryMessage(message)] as const));
	return { revision: first.revision, page: { ...last.page, hasNewer: first.page.hasNewer }, messages };
}

async function readHistoryPage(id: number, request: ChatHistoryPageRequest, signal: AbortSignal) {
	const result = await cancellableFetch(signal, undefined, (cancellation) => loadHistoryPage(id, request, cancellation));
	switch (result.outcome) {
		case "available": return result.value;
		case "not-found": throw new Error("The Chat history could not be loaded.");
		case "network": throw new NetworkError(SERVER_UNREACHABLE_NOTICE);
		case "unusable": throw new Error(result.reason);
	}
}

function historyEdge({ pages }: HistorySnapshot, direction: "older" | "newer") {
	const [first] = pages;
	const last = pages.at(-1) ?? first;
	if (direction === "newer") return first.page.hasNewer ? { page: first.page.index - 1 } : undefined;
	return last.page.hasOlder ? { page: last.page.index + 1 } : undefined;
}

async function readHistoryWindow(
	id: number,
	request: HistoryRead,
	current: HistorySnapshot | undefined,
	signal: AbortSignal,
): Promise<HistorySnapshot | undefined> {
	if (request.kind === "page") {
		if (current === undefined) return undefined;
		const edge = historyEdge(current, request.direction);
		if (edge === undefined) return undefined;
		const page = await readHistoryPage(id, edge, signal);
		if (page.revision !== current.pages[0].revision) throw new SupersededHistory();
		return request.direction === "newer" ? { start: edge, pages: [page, ...current.pages] } : { ...current, pages: [...current.pages, page] };
	}
	const start = request.kind === "jump" ? request.start : current?.start ?? request.initial;
	const count = request.kind === "jump" ? 1 : current?.pages.length ?? 1;
	const first = await readHistoryPage(id, start, signal);
	const pages: HistorySnapshot["pages"] = [first];
	let last = first;
	while (pages.length < count && last.page.hasOlder) {
		last = await readHistoryPage(id, { page: last.page.index + 1 }, signal);
		if (last.revision !== first.revision) throw new SupersededHistory();
		pages.push(last);
	}
	return { start, pages };
}

async function readAndCommitHistory({
	client, id, visit, request, signal, onCommit,
}: {
	client: QueryClient; id: number; visit: number; request: HistoryRead; signal: AbortSignal; onCommit: () => void;
}) {
	const key = historyWindowKey(id, visit);
	let read = request;
	for (let attempt = 1; ; attempt++) {
		const base = client.getQueryData<HistorySnapshot>(key);
		try {
			const next = await readHistoryWindow(id, read, base, signal);
			if (next === undefined) return;
			const revision = next.pages[0].revision;
			const summaryKey = conversationKey(id);
			const cached = client.getQueryData<ConversationSummary | null>(summaryKey);
			const summary = cached === undefined ? await client.ensureQueryData(conversationQuery(client, id)) : cached;
			if (summary === null) throw new Error("The Conversation no longer exists.");
			if (revision > summary.revision || (read.kind === "jump" && read.refreshSummary && attempt === 1)) {
				await client.fetchQuery({ ...conversationQuery(client, id, { invalidateHistory: false }), staleTime: 0 });
			}
			signal.throwIfAborted();
			const latest = client.getQueryData<HistorySnapshot>(key);
			const authority = client.getQueryData<ConversationSummary | null>(summaryKey);
			if (authority === null) throw new Error("The Conversation no longer exists.");
			if (authority?.revision !== revision || (latest !== undefined && revision < latest.pages[0].revision) ||
				(read.kind !== "jump" && base !== latest)) throw new SupersededHistory();
			client.setQueryData(key, next);
			onCommit();
			return revision;
		} catch (error) {
			signal.throwIfAborted();
			if (!(error instanceof SupersededHistory) || attempt === HISTORY_ATTEMPTS) throw error;
			if (read.kind === "page" && base !== undefined) read = { kind: "refresh", initial: base.start };
		}
	}
}

const afterRender = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));

/** @approved Coordinates the selected Chat's authoritative snapshot and paginated reading history. */
export function useConversationSession({ initialChatId }: { initialChatId: string }) {
	const client = useQueryClient();
	// @approved
	//  Each selection is a new visit, even when a batch returns to the same Chat.
	const [{ activeChatId, visit, initialHistory }, setSelection] = useState<{
		activeChatId: string; visit: number; initialHistory: ChatHistoryPageRequest;
	}>({
		activeChatId: initialChatId, visit: 0, initialHistory: { page: 1 },
	});
	const signal = useVisitSignal(visit);
	const navigation = useRef<Navigation>({
		jumps: new Set(), window: new AbortController(), paging: null,
	});
	const [loadingMore, setLoadingMore] = useState(false);
	const [historyFailed, setHistoryFailed] = useState(false);
	const [displayedVisit, setDisplayedVisit] = useState<number | null>(null);
	const pendingMessage = useRef<number | null>(null);
	const activeChatIdRef = useRef(activeChatId);
	const id = Number(activeChatId);
	const conversationId = Number.isInteger(id) && id > 0 ? id : null;
	const currentSession = useEffectEvent(() => ({ signal, story, visit, conversationId }));
	const conversationRead = useConversationQuery(conversationId);
	const windowKey = historyWindowKey(id, visit);
	const history = useQuery({ queryKey: windowKey, queryFn: skipToken, select: selectHistoryWindow });
	const runHistory = async (request: HistoryRead, owner: AbortSignal, onCommit?: () => void) => {
		try {
			return await readAndCommitHistory({ client, id, visit, request, signal: owner, onCommit: () => {
				onCommit?.();
				setHistoryFailed(false);
			} });
		} catch (error) {
			if (!owner.aborted) setHistoryFailed(true);
			throw error;
		}
	};
	// @approved
	// This query schedules refreshes. Only readAndCommitHistory writes the displayed window.
	const refreshKey = historyRefreshKey(id, visit);
	useQuery({
		queryKey: refreshKey, enabled: conversationId !== null, staleTime: Infinity, retry: false, refetchOnReconnect: false,
		refetchOnMount: () => {
			const cached = client.getQueryData<HistorySnapshot>(windowKey);
			const summary = client.getQueryData<ConversationSummary | null>(conversationKey(id));
			return cached === undefined || cached.pages[0].revision < (summary?.revision ?? 0) ? "always" : true;
		},
		queryFn: async ({ signal: querySignal }) => {
			return await runHistory({ kind: "refresh", initial: initialHistory }, AbortSignal.any([signal, querySignal, navigation.current.window.signal])) ?? null;
		},
	});
	const [overlays, setOverlays] = useState(createStoryOverlays);
	const dispatchStory = useCallback((action: StoryAction) => setOverlays((current) => reduceStoryOverlays(current, action)), []);
	const conversation = conversationRead.data ?? null;
	const setConversation = useCallback((next: ConversationSummary | null) => {
		if (signal.aborted || Number(activeChatIdRef.current) !== conversationId) return;
		if (next !== null && next.id === conversationId) publishConversation(client, next);
		else if (next === null) client.setQueryData(conversationKey(conversationId), null);
	}, [client, conversationId, signal]);

	const selected = history.data;
	const historyWindow = useMemo<StoryWindow | null>(() => selected === undefined ? null : {
		revision: selected.revision, page: selected.page, messages: Object.values(selected.messages).sort((a, b) => a.position - b.position),
	}, [selected]);
	const visibleWindow = displayedVisit === visit || (historyWindow !== null && historyWindow.revision === conversation?.revision)
		? historyWindow : null;
	if (visibleWindow !== null && displayedVisit !== visit) setDisplayedVisit(visit);
	const currentOverlays = visibleWindow === null ? overlays : retireStoryOverlays(overlays, visibleWindow, conversation);
	if (currentOverlays !== overlays) setOverlays(currentOverlays);
	const story = readStory({ overlays: currentOverlays, window: visibleWindow, conversationId, historyFailed, loadingMore });

	const workspace = useQuery({ ...workspaceQuery, enabled: false }).data;
	const activeChatTitle = conversation?.name ?? workspace?.chats.find((chat) => chat.id === activeChatId)?.title ?? "Chat";
	const cancelPaging = () => {
		navigation.current.paging?.abort();
		navigation.current.paging = null;
		setLoadingMore(false);
	};
	const selectChat = (chatId: string, messageId: number | null = null) => {
		if (chatId === activeChatIdRef.current) return;
		for (const jump of navigation.current.jumps) jump.abort();
		navigation.current.window.abort();
		cancelPaging();
		navigation.current = { jumps: new Set(), window: new AbortController(), paging: null };
		void client.cancelQueries({ queryKey: refreshKey });
		void client.invalidateQueries({ queryKey: conversationKey(Number(chatId)) });
		activeChatIdRef.current = chatId;
		pendingMessage.current = messageId;
		setHistoryFailed(false);
		setOverlays(createStoryOverlays());
		setSelection((current) => ({
			activeChatId: chatId, visit: current.visit + 1, initialHistory: messageId === null ? { page: 1 } : { aroundMessageId: messageId },
		}));
	};

	const loadMoreHistory = async (direction: "older" | "newer" = "older") => {
		const active = navigation.current;
		if (active.paging !== null || active.jumps.size > 0 || signal.aborted || client.isFetching({ queryKey: refreshKey }) > 0) return;
		const current = client.getQueryData<HistorySnapshot>(windowKey);
		if (current === undefined || historyEdge(current, direction) === undefined) return;
		const paging = new AbortController();
		active.paging = paging;
		setLoadingMore(true);
		try {
			await runHistory({ kind: "page", direction }, AbortSignal.any([signal, paging.signal]));
		} catch { return; }
		finally {
			if (navigation.current.paging === paging) {
				navigation.current.paging = null;
				setLoadingMore(false);
			}
		}
	};

	const beginNavigation = () => {
		const jump = new AbortController();
		navigation.current.jumps.add(jump);
		return jump;
	};
	const finishNavigation = (winner: AbortController) => {
		for (const jump of navigation.current.jumps) {
			if (jump === winner) break;
			jump.abort();
			navigation.current.jumps.delete(jump);
		}
		cancelPaging();
	};
	const openWindow = (request: Extract<HistoryRead, { kind: "jump" }>, jump: AbortController, owner: AbortSignal) => {
		return runHistory(request, owner, () => {
			finishNavigation(jump);
			navigation.current.window.abort();
			navigation.current.window = new AbortController();
			void client.cancelQueries({ queryKey: refreshKey });
		});
	};
	const navigateToSourceMessage = async (messageId: number) => {
		const current = currentSession().story;
		if (!isStoryReady(current) || signal.aborted) return;
		const jump = beginNavigation();
		const navigationSignal = AbortSignal.any([signal, jump.signal]);
		try {
			if (current.messages.some((message) => message.id === messageId)) finishNavigation(jump);
			else await openWindow({ kind: "jump", start: { aroundMessageId: messageId }, refreshSummary: false }, jump, navigationSignal);
			await afterRender();
			navigationSignal.throwIfAborted();
			document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)?.scrollIntoView({ behavior: "instant", block: "center" });
			await afterRender();
		} catch (error) { if (!navigationSignal.aborted) throw error; }
		finally { navigation.current.jumps.delete(jump); }
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
		const current = currentSession();
		if (current.conversationId !== id) return null;
		const refresh = AbortSignal.any([current.signal, ...(external ? [external] : []), navigation.current.window.signal]);
		try {
			refresh.throwIfAborted();
			await client.fetchQuery({ ...conversationQuery(client, id, { owner: refresh }), staleTime: 0 });
			refresh.throwIfAborted();
			await client.refetchQueries({ queryKey: historyRefreshKey(id, current.visit), type: "active" }, { cancelRefetch: false, throwOnError: true });
			refresh.throwIfAborted();
			return client.getQueryData<ConversationSummary | null>(conversationKey(id)) ?? null;
		} catch (error) {
			if (!refresh.aborted) setHistoryFailed(true);
			throw error;
		}
	}, [client]);

	const jumpToLatest = async () => {
		if (signal.aborted || !isStoryReady(currentSession().story)) return null;
		const jump = beginNavigation();
		const navigationSignal = AbortSignal.any([signal, jump.signal]);
		try {
			await openWindow({ kind: "jump", start: { page: 1 }, refreshSummary: true }, jump, navigationSignal);
			await afterRender();
			navigationSignal.throwIfAborted();
			const root = document.querySelector<HTMLElement>(".story-scroll");
			root?.scrollTo({ top: root.scrollHeight, behavior: "instant" });
			return client.getQueryData<ConversationSummary | null>(conversationKey(id)) ?? null;
		} finally { navigation.current.jumps.delete(jump); }
	};
	const ensureLatest = async () => {
		if (signal.aborted) return null;
		const current = client.getQueryData<HistorySnapshot>(windowKey);
		return current?.pages[0].page.hasNewer ? jumpToLatest() : client.getQueryData<ConversationSummary | null>(conversationKey(id)) ?? null;
	};

	return {
		signal, activeChatId, activeChatTitle, conversation, setConversation, activeChatIdRef, story, dispatchStory,
		selectChat, loadMoreHistory, jumpToLatest, ensureLatest, navigateToSourceMessage, refreshStory,
	};
}
