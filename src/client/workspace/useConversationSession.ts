import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useEffectEvent, useRef, useState, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { loadHistoryPage, type ChatHistoryPageRequest } from "../chat-history";
import type { ConversationSummary } from "../conversation";
import { conversationKey, conversationQuery, publishConversation, useConversationQuery } from "../conversation-query";
import type { StoryAction, StoryState } from "../story";
import type { ChatSummary, Workspace } from "../workspace";
import { NetworkError, SERVER_UNREACHABLE_NOTICE } from "../lib/request-outcome";

type ConversationSessionOptions = {
	initialWorkspace: Workspace & { activeChat: ChatSummary };
	story: StoryState;
	dispatchStory: Dispatch<StoryAction>;
};

const historyKey = (id: number) => ["conversation-history", id] as const;
const historyQuery = (client: QueryClient, id: number, request: ChatHistoryPageRequest, owner?: AbortSignal) => ({
	queryKey: [...historyKey(id), request],
	staleTime: () => {
		const page = client.getQueryData<Awaited<ReturnType<typeof loadHistoryPage>>>([...historyKey(id), request]);
		const authority = client.getQueryData<ConversationSummary | null>(conversationKey(id));
		return page?.outcome === "available" && page.value.revision < (authority?.revision ?? 0) ? 0 : Infinity;
	},
	refetchOnReconnect: false,
	queryFn: async ({ signal }: { signal: AbortSignal }) => {
		const cancellation = owner ? AbortSignal.any([signal, owner]) : signal;
		await Promise.resolve();
		cancellation.throwIfAborted();
		const outcome = await loadHistoryPage(id, request, cancellation);
		cancellation.throwIfAborted();
		const current = client.getQueryData<Awaited<ReturnType<typeof loadHistoryPage>>>([...historyKey(id), request]);
		return outcome.outcome === "available" && current?.outcome === "available" && current.value.revision > outcome.value.revision ? current : outcome;
	},
});
const selection = (activeChatId: string) => ({ activeChatId, owner: { cancellation: new AbortController(), opened: false, paging: false, window: new AbortController(), navigating: false } });
const afterRender = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())));

/** @approved Coordinates the selected Chat's authoritative snapshot and paginated reading history. */
export function useConversationSession({ initialWorkspace, story, dispatchStory }: ConversationSessionOptions) {
	const client = useQueryClient();
	const [{ activeChatId, owner }, setSelection] = useState(() => selection(initialWorkspace.activeChat.id));
	const activeChatIdRef = useRef(activeChatId);
	const id = Number(activeChatId);
	const conversationId = Number.isInteger(id) && id > 0 ? id : null;
	const currentSession = useEffectEvent(() => ({ story, owner }));
	const applyStory = useCallback((action: StoryAction) => { flushSync(() => dispatchStory(action)); }, [dispatchStory]);
	const conversationRead = useConversationQuery(conversationId);
	const history = useQuery({
		...historyQuery(client, id, { page: 1 }),
		enabled: conversationId !== null,
	});
	const conversation = conversationRead.data ?? null;
	const setConversation = useCallback((next: ConversationSummary | null) => {
		if (owner.cancellation.signal.aborted || Number(activeChatIdRef.current) !== conversationId) return;
		if (next !== null && next.id === conversationId) publishConversation(client, next);
		else if (next === null) client.setQueryData(conversationKey(conversationId), null);
	}, [client, conversationId, owner]);

	useEffect(() => {
		if (owner.cancellation.signal.aborted) { owner.cancellation = new AbortController(); owner.window = new AbortController(); owner.opened = false; }
		if (conversationId !== null) dispatchStory({ type: "chat-opened", conversationId });
		return () => { owner.cancellation.abort(); owner.window.abort(); };
	}, [conversationId, owner, dispatchStory]);

	useEffect(() => {
		if (owner.opened || owner.cancellation.signal.aborted || conversationRead.data === undefined || history.data === undefined || history.isFetching) return;
		if (history.data.outcome === "available" && history.data.value.revision < (conversation?.revision ?? 0)) {
			void history.refetch();
			return;
		}
		owner.opened = true;
		if (history.data.outcome === "available") {
			dispatchStory({ type: "first-page", page: history.data.value, activeGenerationIds: conversation?.activeGenerations.map(({ generationId }) => generationId) });
		} else dispatchStory({ type: "history-failed" });
	}, [conversationRead.data, conversation, history.data, history.isFetching, history.refetch, owner, dispatchStory]);

	const listedChat = initialWorkspace.chats.find((chat) => chat.id === activeChatId) ?? initialWorkspace.activeChat;
	const activeChat = conversation !== null && String(conversation.id) === listedChat.id ? { ...listedChat, title: conversation.name } : listedChat;

	const selectChat = (chatId: string) => {
		if (chatId === activeChatIdRef.current) return;
		owner.cancellation.abort();
		owner.window.abort();
		void client.cancelQueries({ queryKey: historyKey(id) });
		void client.invalidateQueries({ queryKey: conversationKey(Number(chatId)), refetchType: "none" });
		void client.invalidateQueries({ queryKey: historyKey(Number(chatId)), refetchType: "none" });
		activeChatIdRef.current = chatId;
		setSelection(selection(chatId));
	};

	const readHistory = useCallback((id: number, request: ChatHistoryPageRequest, signal: AbortSignal) =>
		client.fetchQuery({ ...historyQuery(client, id, request, signal), staleTime: 0 }), [client]);
	const applyPage = useCallback((action: Extract<StoryAction, { page: unknown }>, signal: AbortSignal) => {
		if (signal.aborted) return false;
		const current = currentSession().story;
		const authority = client.getQueryData<ConversationSummary | null>(conversationKey(action.page.conversationId));
		if (current.conversationId !== action.page.conversationId || action.page.revision < Math.max(current.revision ?? 0, authority?.revision ?? 0)) return false;
		applyStory(action.type === "next-page-arrived" ? action : { ...action, activeGenerationIds: authority?.activeGenerations.map(({ generationId }) => generationId) });
		return true;
	}, [client, applyStory]);

	const refreshHistoryPage = (messageId: number) => {
		const signal = AbortSignal.any([owner.cancellation.signal, owner.window.signal]);
		return readHistory(id, { aroundMessageId: messageId }, signal).then((outcome) => {
			if (outcome.outcome === "available") applyPage({ type: "history-refreshed", page: outcome.value }, signal);
		}).catch(() => undefined);
	};

	const loadMoreHistory = async (direction: "older" | "newer" = "older") => {
		const current = currentSession().story;
		const id = current.conversationId;
		const edge = direction === "older" ? current.messages[0] : current.messages.at(-1);
		if (id === null || !edge || (current.status !== "ready" && current.status !== "error") || owner.paging || owner.navigating || owner.cancellation.signal.aborted ||
			!(direction === "older" ? current.page?.hasOlder : current.page?.hasNewer)) return;
		const signal = AbortSignal.any([owner.cancellation.signal, owner.window.signal]);
		owner.paging = true;
		applyStory({ type: "load-more-started" });
		try {
			const anchor = await readHistory(id, { aroundMessageId: edge.id }, signal);
			signal.throwIfAborted();
			if (anchor.outcome !== "available") { applyStory({ type: "history-failed" }); return; }
			const extendsWindow = anchor.value.messages.some((message) => direction === "older" ? message.position < edge.position : message.position > edge.position);
			const outcome = extendsWindow ? anchor : await readHistory(id, { page: anchor.value.page.index + (direction === "older" ? 1 : -1) }, signal);
			signal.throwIfAborted();
			if (outcome.outcome !== "available" || !applyPage({ type: "next-page-arrived", page: outcome.value }, signal)) applyStory({ type: "history-failed" });
		} catch {
			if (!signal.aborted && !owner.navigating) applyStory({ type: "history-failed" });
		} finally { if (!signal.aborted) owner.paging = false; }
	};

	const beginNavigation = () => {
		owner.opened = true;
		owner.window.abort();
		void client.cancelQueries({ queryKey: historyKey(id) });
		owner.window = new AbortController();
		owner.navigating = true;
		owner.paging = false;
		applyStory({ type: "paging-cancelled" });
		return AbortSignal.any([owner.cancellation.signal, owner.window.signal]);
	};

	const navigateToSourceMessage = async (messageId: number) => {
		const current = currentSession().story;
		const id = current.conversationId;
		if (id === null || owner.cancellation.signal.aborted) return;
		const signal = beginNavigation();
		try {
			if (!current.messages.some((message) => message.id === messageId)) {
				const outcome = await readHistory(id, { aroundMessageId: messageId }, signal);
				signal.throwIfAborted();
				if (outcome.outcome !== "available") { applyStory({ type: "history-failed" }); return; }
				if (!applyPage({ type: "first-page", page: outcome.value }, signal)) { applyStory({ type: "history-failed" }); return; }
			}
			await afterRender();
			signal.throwIfAborted();
			document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)?.scrollIntoView({ behavior: "instant", block: "center" });
			await afterRender();
		} catch (error) { if (!signal.aborted) throw error; }
		finally { if (!signal.aborted) owner.navigating = false; }
	};

	const refreshStory = useCallback(async (id: number, external?: AbortSignal) => {
		const { story: current, owner } = currentSession();
		const signal = AbortSignal.any([owner.cancellation.signal, ...(external ? [external] : []), owner.window.signal]);
		signal.throwIfAborted();
		const detached = current.page?.hasNewer === true;
		await client.cancelQueries({ queryKey: conversationKey(id) });
		const freshConversation = await client.fetchQuery({ ...conversationQuery(client, id, signal), staleTime: 0 });
		signal.throwIfAborted();
		const pageSize = current.page?.pageSize ?? 1;
		const requests = detached
			? current.messages.filter((_, index) => index % pageSize === 0 || index === current.messages.length - 1).map((message) => ({ aroundMessageId: message.id }))
			: [{ page: 1 }];
		for (const request of requests) {
			const outcome = await readHistory(id, request, signal);
			signal.throwIfAborted();
			if (outcome.outcome === "not-found") continue;
			if (outcome.outcome === "network") throw new NetworkError(SERVER_UNREACHABLE_NOTICE);
			if (outcome.outcome === "unusable") throw new Error(outcome.reason);
			applyPage({ type: detached ? "history-refreshed" : "first-page", page: outcome.value, activeGenerationIds: freshConversation?.activeGenerations.map(({ generationId }) => generationId) }, signal);
		}
		return freshConversation;
	}, [client, readHistory, applyPage]);

	const jumpToLatest = async () => {
		const id = currentSession().story.conversationId;
		if (id === null) throw new Error("No Chat is open.");
		const signal = beginNavigation();
		try {
			await client.cancelQueries({ queryKey: conversationKey(id) });
			const [loaded, outcome] = await Promise.all([
				client.fetchQuery({ ...conversationQuery(client, id, signal), staleTime: 0 }),
				readHistory(id, { page: 1 }, signal),
			]);
			signal.throwIfAborted();
			if (loaded === null || outcome.outcome !== "available") throw new Error("The latest Messages could not be loaded.");
			if (!applyPage({ type: "first-page", page: outcome.value }, signal)) throw new Error("The Conversation changed while loading the latest Messages.");
			await afterRender();
			signal.throwIfAborted();
			const root = document.querySelector<HTMLElement>(".story-scroll");
			root?.scrollTo({ top: root.scrollHeight, behavior: "instant" });
			return loaded;
		} finally { if (!signal.aborted) owner.navigating = false; }
	};
	const ensureLatest = async () => currentSession().story.page?.hasNewer ? jumpToLatest() : client.getQueryData<ConversationSummary | null>(conversationKey(id)) ?? null;

	return {
		refreshHistoryPage, signal: owner.cancellation.signal, activeChatId, activeChat, conversation, setConversation, activeChatIdRef,
		selectChat, loadMoreHistory, jumpToLatest, ensureLatest, navigateToSourceMessage, refreshStory,
	};
}
