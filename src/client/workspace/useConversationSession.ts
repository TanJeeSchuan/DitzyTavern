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

function historyStart({ pages, sourceMessageId }: HistorySnapshot): ChatHistoryPageRequest {
	return sourceMessageId === undefined ? { page: pages[0].page.index } : { aroundMessageId: sourceMessageId };
}

async function readHistoryWindow(
	id: number,
	start: ChatHistoryPageRequest,
	base: HistorySnapshot | undefined,
	signal: AbortSignal,
): Promise<HistorySnapshot["pages"]> {
	const anchor = await readHistoryPage(id, start, signal);
	const before = start.aroundMessageId === undefined ? 0 :
		Math.max(0, base?.pages.findIndex(({ messages }) => messages.some(({ id }) => id === start.aroundMessageId)) ?? 0);
	const first = base?.pages[0].page.index === 1 ? 1 : Math.max(1, anchor.page.index - before);
	const last = Math.min(anchor.page.totalPages, anchor.page.index + (base?.pages.length ?? 1) - before - 1);
	const pages: HistorySnapshot["pages"] = [anchor];
	for (let index = first; index <= last; index++) {
		if (index === anchor.page.index) continue;
		const page = await readHistoryPage(id, { page: index }, signal);
		if (page.revision !== anchor.revision) throw new SupersededHistory();
		pages.push(page);
	}
	pages.sort((a, b) => a.page.index - b.page.index);
	return pages;
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
		const start: ChatHistoryPageRequest | undefined = missingSource ? { page: 1 } : read.kind === "jump" ? read.start : read.kind === "refresh" ? (base === undefined ? read.initial : historyStart(base)) : edge;
		if (start === undefined) return;
		try {
			const pages = await readHistoryWindow(id, start, read.kind === "refresh" && !missingSource ? base : undefined, signal);
			const [page] = pages;
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
			let next: HistorySnapshot = { sourceMessageId: start.aroundMessageId, pages };
			if (read.kind === "page") {
				if (latest?.pages[0].revision !== revision) throw new SupersededHistory();
				if (historyEdge(latest, read.direction)?.page !== start.page) throw new ChangedHistoryWindow();
				next = read.direction === "newer" ? { ...latest, pages: [page, ...latest.pages] } : { ...latest, pages: [...latest.pages, page] };
			} else if (read.kind === "refresh" && base !== latest) throw new SupersededHistory();
			onCommit();
			client.setQueryData(key, next);
			return next;
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof MissingSource) {
				missingSource = true;
				attempt = 0;
				continue;
			}
			if (attempt === HISTORY_ATTEMPTS || (!(error instanceof SupersededHistory) && !isCancelledError(error))) throw error;
			if (read.kind === "page" && base !== undefined && !(error instanceof ChangedHistoryWindow)) read = { kind: "refresh", initial: historyStart(base) };
		}
	}
}

const afterRender = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
	signal.throwIfAborted();
	let frame = window.requestAnimationFrame(() => {
		frame = window.requestAnimationFrame(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		});
	});
	const abort = () => {
		window.cancelAnimationFrame(frame);
		reject(signal.reason);
	};
	signal.addEventListener("abort", abort, { once: true });
});

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

	useEffect(() => {
		const { inlineDrafts } = currentSession().story;
		if (historyWindow === null || inlineDrafts.size === 0) return;
		const { revision, messages, page } = historyWindow;
		const visible = new Set(messages.map(({ id }) => id));
		const discardDeleted = (messageId: number) => dispatchStory({ type: "inline-draft-changed", messageId, draft: undefined });
		for (const [messageId, draft] of inlineDrafts) {
			if (draft.baseRevision >= revision || visible.has(messageId)) continue;
			if (page.totalMessages === messages.length) {
				discardDeleted(messageId);
				continue;
			}
			void client.fetchQuery({
				queryKey: ["inline-draft-source", id, messageId, revision],
				staleTime: Infinity,
				retry: false,
				queryFn: async ({ signal: querySignal }) => {
					try {
						await readHistoryPage(id, { aroundMessageId: messageId }, querySignal);
						return true;
					} catch (error) {
						if (error instanceof MissingSource) return false;
						throw error;
					}
				},
			}).then((exists) => { if (!exists) discardDeleted(messageId); }, () => undefined);
		}
	}, [client, id, historyWindow, dispatchStory]);

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
			const committed = client.getQueryData<HistorySnapshot>(windowKey);
			const alreadyShown = committed?.pages.some((page) => page.messages.some((message) => message.id === messageId)) === true;
			const opened = alreadyShown ? undefined : await openWindow({ kind: "jump", start: { aroundMessageId: messageId }, refreshSummary: false }, jump, navigationSignal);
			if (alreadyShown) finishNavigation(jump);
			await afterRender(navigationSignal);
			navigationSignal.throwIfAborted();
			if (!alreadyShown && opened?.sourceMessageId === undefined) scrollToLatest();
			else document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)?.scrollIntoView({ behavior: "instant", block: "center" });
			await afterRender(navigationSignal);
		} catch (error) { if (!navigationSignal.aborted) throw error; }
		finally { navigation.current.jumps.delete(jump); }
	};
	useEffect(() => {
		const messageId = pendingMessage.current;
		if (messageId === null || story.status !== "ready") return;
		pendingMessage.current = null;
		if (!story.messages.some((message) => message.id === messageId)) return;
		const initialScroll = navigation.current.initialScroll.signal;
		void afterRender(AbortSignal.any([signal, initialScroll])).then(() => {
			if (!signal.aborted && !initialScroll.aborted) document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)?.scrollIntoView({ behavior: "instant", block: "center" });
		}, () => undefined);
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

	const waitForHistory = async (minimumRevision = 0) => {
		const requiredRevision = () => Math.max(minimumRevision, client.getQueryData<ConversationSummary | null>(conversationKey(id))?.revision ?? 0);
		const revision = client.getQueryData<HistorySnapshot>(windowKey)?.pages[0].revision ?? 0;
		if (revision < requiredRevision()) {
			await client.refetchQueries({ queryKey: refreshKey, type: "active" }, { cancelRefetch: false, throwOnError: true });
		}
		await afterRender(signal);
		signal.throwIfAborted();
		const displayed = currentSession().story;
		if (!isStoryReady(displayed) || displayed.revision < requiredRevision()) throw new Error("The Chat history could not be loaded.");
		return displayed;
	};

	const jumpToLatest = async () => {
		if (signal.aborted || conversationId === null) return null;
		const jump = beginNavigation();
		const navigationSignal = AbortSignal.any([signal, jump.signal]);
		try {
			await openWindow({ kind: "jump", start: { page: 1 }, refreshSummary: true }, jump, navigationSignal);
			await afterRender(navigationSignal);
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
