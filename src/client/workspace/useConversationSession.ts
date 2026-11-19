import { createStoryOverlays, isStoryReady, readStory, reduceStoryOverlays, retireStoryOverlays, toStoryMessage, type StoryAction, type StoryWindow } from "../story";
import { isCancelledError, skipToken, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { loadHistoryPage, type ChatHistoryPageRequest, type HistorySnapshot } from "../chat-history";
import type { ConversationSummary } from "../conversation";
import { cancellableFetch, historyWindowKey, conversationHistoryKey, conversationKey, conversationQuery, publishConversation, useConversationQuery } from "../conversation-query";
import { workspaceQuery } from "../workspace";
import { NetworkError, SERVER_UNREACHABLE_NOTICE } from "../lib/request-outcome";
import { useVisitSignal } from "../lib/visit";

type HistoryRead =
	| { kind: "refresh"; initial: ChatHistoryPageRequest }
	| { kind: "jump"; start: ChatHistoryPageRequest; refreshSummary: boolean }
	| { kind: "page"; direction: "older" | "newer" };

function createNavigation() {
	let paging: AbortController | null = null;
	const listeners = new Set<() => void>();
	return {
		jumps: new Set<AbortController>(), window: new AbortController(), selection: new AbortController(), initialScroll: new AbortController(),
		getPaging: () => paging,
		subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
		setPaging: (next: AbortController | null) => { paging = next; for (const notify of listeners) notify(); },
	};
}
class SupersededHistory extends Error {}
class ChangedHistoryWindow extends SupersededHistory {}
class MissingSource extends Error {}
const HISTORY_ATTEMPTS = 3;

let nextVisit = 0;
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
	const result = await cancellableFetch(signal, (cancellation) => loadHistoryPage(id, request, cancellation));
	switch (result.outcome) {
		case "available": return result.value;
		case "not-found":
			if (request.aroundMessageId !== undefined) throw new MissingSource();
			throw new Error("The Chat history could not be loaded.");
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
	start: ChatHistoryPageRequest,
	count: number,
	signal: AbortSignal,
): Promise<HistorySnapshot> {
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
	const key = historyWindowKey(historyRefreshKey(id, visit));
	let read = request;
	let missingSource = false;
	for (let attempt = 1; ; attempt++) {
		const base = client.getQueryData<HistorySnapshot>(key);
		const edge = read.kind === "page" && base !== undefined ? historyEdge(base, read.direction) : undefined;
		const start = missingSource ? { page: 1 } : read.kind === "jump" ? read.start : read.kind === "refresh" ? base?.start ?? read.initial : edge;
		if (start === undefined) return;
		try {
			const count = read.kind === "refresh" && !missingSource ? base?.pages.length ?? 1 : 1;
			const result = await readHistoryWindow(id, start, count, signal);
			const [page] = result.pages;
			const revision = page.revision;
			if (read.kind === "page" && base?.pages[0].revision !== revision) throw new SupersededHistory();
			const summaryKey = conversationKey(id);
			const cached = client.getQueryData<ConversationSummary | null>(summaryKey);
			const summary = cached === undefined ? await client.ensureQueryData(conversationQuery(client, id)) : cached;
			if (summary === null) throw new Error("The Conversation no longer exists.");
			if (revision > summary.revision || (read.kind === "jump" && read.refreshSummary && attempt === 1)) {
				await client.fetchQuery({ ...conversationQuery(client, id), staleTime: 0 });
			}
			signal.throwIfAborted();
			const latest = client.getQueryData<HistorySnapshot>(key);
			const authority = client.getQueryData<ConversationSummary | null>(summaryKey);
			if (authority === null) throw new Error("The Conversation no longer exists.");
			if (authority?.revision !== revision || (latest !== undefined && revision < latest.pages[0].revision)) throw new SupersededHistory();
			let next = result;
			if (read.kind === "page") {
				if (latest?.pages[0].revision !== revision) throw new SupersededHistory();
				if (historyEdge(latest, read.direction)?.page !== start.page) throw new ChangedHistoryWindow();
				next = read.direction === "newer" ? { start, pages: [page, ...latest.pages] } : { ...latest, pages: [...latest.pages, page] };
			} else if (read.kind === "refresh" && base !== latest) throw new SupersededHistory();
			client.setQueryData(key, next);
			onCommit();
			return next;
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof MissingSource) {
				missingSource = true;
				attempt = 0;
				continue;
			}
			if (attempt === HISTORY_ATTEMPTS || (!(error instanceof SupersededHistory) && !isCancelledError(error))) throw error;
			if (read.kind === "page" && base !== undefined && !(error instanceof ChangedHistoryWindow)) read = { kind: "refresh", initial: base.start };
		}
	}
}

const afterRender = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));

function scrollToLatest() {
	const root = document.querySelector<HTMLElement>(".story-scroll");
	root?.scrollTo({ top: root.scrollHeight, behavior: "instant" });
}

/** @approved Coordinates the selected Chat's authoritative snapshot and paginated reading history. */
export function useConversationSession({ initialChatId }: { initialChatId: string }) {
	const client = useQueryClient();
	// @approved
	//  Each selection is a new visit, even when a batch returns to the same Chat.
	const [{ activeChatId, visit, initialHistory }, setSelection] = useState<{
		activeChatId: string; visit: number; initialHistory: ChatHistoryPageRequest;
	}>(() => ({
		activeChatId: initialChatId, visit: ++nextVisit, initialHistory: { page: 1 },
	}));
	const mounted = useVisitSignal(visit);
	const navigation = useRef(createNavigation());
	const selection = navigation.current.selection.signal;
	const signal = useMemo(() => AbortSignal.any([mounted, selection]), [mounted, selection]);
	const paging = useSyncExternalStore(navigation.current.subscribe, navigation.current.getPaging);
	const [historyFailed, setHistoryFailed] = useState(false);
	const pendingMessage = useRef<number | null>(null);
	const activeChatIdRef = useRef(activeChatId);
	const id = Number(activeChatId);
	const conversationId = Number.isInteger(id) && id > 0 ? id : null;
	const currentSession = useEffectEvent(() => ({ signal, story, visit, conversationId }));
	const conversationRead = useConversationQuery(conversationId);
	const windowKey = historyWindowKey(historyRefreshKey(id, visit));
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
		queryFn: async ({ signal: querySignal }) => {
			await runHistory({ kind: "refresh", initial: initialHistory }, AbortSignal.any([signal, querySignal, navigation.current.window.signal]));
			return null;
		},
	});
	const [overlays, setOverlays] = useState(createStoryOverlays);
	const dispatchStory = useCallback((action: StoryAction) => {
		if (!signal.aborted) setOverlays((current) => reduceStoryOverlays(current, action));
	}, [signal]);
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
	const currentOverlays = historyWindow === null ? overlays : retireStoryOverlays(overlays, historyWindow, conversation);
	if (currentOverlays !== overlays) setOverlays(currentOverlays);
	const story = readStory({ overlays: currentOverlays, window: historyWindow, conversationId, historyFailed, loadingMore: paging !== null });

	const workspace = useQuery({ ...workspaceQuery, enabled: false }).data;
	const activeChatTitle = conversation?.name ?? workspace?.chats.find((chat) => chat.id === activeChatId)?.title ?? "Chat";
	const cancelPaging = () => {
		navigation.current.getPaging()?.abort();
		navigation.current.setPaging(null);
	};
	const selectChat = (chatId: string, messageId: number | null = null) => {
		if (chatId === activeChatIdRef.current) {
			if (messageId !== null) void navigateToSourceMessage(messageId).catch(() => undefined);
			else if (historyFailed) void refreshStory(id).catch(() => undefined);
			return;
		}
		navigation.current.selection.abort();
		for (const jump of navigation.current.jumps) jump.abort();
		navigation.current.window.abort();
		cancelPaging();
		navigation.current = createNavigation();
		void client.cancelQueries({ queryKey: refreshKey });
		void client.invalidateQueries({ queryKey: conversationKey(Number(chatId)) });
		activeChatIdRef.current = chatId;
		pendingMessage.current = messageId;
		setHistoryFailed(false);
		setOverlays(createStoryOverlays());
		setSelection({
			activeChatId: chatId, visit: ++nextVisit, initialHistory: messageId === null ? { page: 1 } : { aroundMessageId: messageId },
		});
	};

	const loadMoreHistory = async (direction: "older" | "newer" = "older") => {
		const active = navigation.current;
		if (active.getPaging() !== null || active.jumps.size > 0 || signal.aborted || client.isFetching({ queryKey: refreshKey }) > 0) return;
		const current = client.getQueryData<HistorySnapshot>(windowKey);
		if (current === undefined || historyEdge(current, direction) === undefined) return;
		const paging = new AbortController();
		active.setPaging(paging);
		try {
			await runHistory({ kind: "page", direction }, AbortSignal.any([signal, paging.signal]));
		} catch { return; }
		finally {
			if (active.getPaging() === paging) active.setPaging(null);
		}
	};

	const beginNavigation = () => {
		pendingMessage.current = null;
		navigation.current.initialScroll.abort();
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
		if (conversationId === null || signal.aborted) return;
		const jump = beginNavigation();
		const navigationSignal = AbortSignal.any([signal, jump.signal]);
		try {
			const alreadyShown = currentSession().story.messages.some((message) => message.id === messageId);
			const opened = alreadyShown ? undefined : await openWindow({ kind: "jump", start: { aroundMessageId: messageId }, refreshSummary: false }, jump, navigationSignal);
			if (alreadyShown) finishNavigation(jump);
			await afterRender();
			navigationSignal.throwIfAborted();
			if (!alreadyShown && opened?.start.aroundMessageId === undefined) scrollToLatest();
			else document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)?.scrollIntoView({ behavior: "instant", block: "center" });
			await afterRender();
		} catch (error) { if (!navigationSignal.aborted) throw error; }
		finally { navigation.current.jumps.delete(jump); }
	};
	useEffect(() => {
		const messageId = pendingMessage.current;
		if (messageId === null || story.status !== "ready") return;
		pendingMessage.current = null;
		if (!story.messages.some((message) => message.id === messageId)) return;
		const initialScroll = navigation.current.initialScroll.signal;
		void afterRender().then(() => {
			if (!signal.aborted && !initialScroll.aborted) document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)?.scrollIntoView({ behavior: "instant", block: "center" });
		});
	}, [story.status, story.messages, signal]);

	const refreshStory = useCallback(async (id: number, external?: AbortSignal) => {
		const current = currentSession();
		if (current.conversationId !== id) return null;
		const refresh = AbortSignal.any([current.signal, ...(external ? [external] : []), navigation.current.window.signal]);
		try {
			refresh.throwIfAborted();
			await client.fetchQuery({ ...conversationQuery(client, id), staleTime: 0 });
			refresh.throwIfAborted();
			await client.refetchQueries({ queryKey: historyRefreshKey(id, current.visit), type: "active" }, { cancelRefetch: false, throwOnError: true });
			refresh.throwIfAborted();
			return client.getQueryData<ConversationSummary | null>(conversationKey(id)) ?? null;
		} catch (error) {
			if (!refresh.aborted) setHistoryFailed(true);
			throw error;
		}
	}, [client]);

	const waitForHistory = async () => {
		const summaryRevision = () => client.getQueryData<ConversationSummary | null>(conversationKey(id))?.revision ?? 0;
		const revision = client.getQueryData<HistorySnapshot>(windowKey)?.pages[0].revision ?? 0;
		if (revision < summaryRevision()) {
			await client.refetchQueries({ queryKey: refreshKey, type: "active" }, { cancelRefetch: false, throwOnError: true });
		}
		await afterRender();
		signal.throwIfAborted();
		const displayed = currentSession().story;
		if (!isStoryReady(displayed) || displayed.revision < summaryRevision()) throw new Error("The Chat history could not be loaded.");
	};

	const jumpToLatest = async () => {
		if (signal.aborted || conversationId === null) return null;
		const jump = beginNavigation();
		const navigationSignal = AbortSignal.any([signal, jump.signal]);
		try {
			await openWindow({ kind: "jump", start: { page: 1 }, refreshSummary: true }, jump, navigationSignal);
			await afterRender();
			navigationSignal.throwIfAborted();
			scrollToLatest();
			return client.getQueryData<ConversationSummary | null>(conversationKey(id)) ?? null;
		} finally { navigation.current.jumps.delete(jump); }
	};
	const ensureLatest = async () => {
		if (signal.aborted) return null;
		const current = client.getQueryData<HistorySnapshot>(windowKey);
		return current === undefined || current.pages[0].page.hasNewer ? jumpToLatest() : client.getQueryData<ConversationSummary | null>(conversationKey(id)) ?? null;
	};

	return {
		signal, activeChatId, activeChatTitle, conversation, setConversation, activeChatIdRef, story, dispatchStory,
		selectChat, loadMoreHistory, jumpToLatest, ensureLatest, navigateToSourceMessage, refreshStory, waitForHistory,
	};
}
