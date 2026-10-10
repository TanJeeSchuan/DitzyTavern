import { afterEach, expect, test } from "bun:test";
import { QueryClient, onlineManager } from "@tanstack/react-query";
import { useCallback, useReducer } from "react";
import { flushHook, renderHook } from "../test-fixtures/render-hook";
import { createStoryState, reduceStory, type StoryAction } from "../story";
import type { ChatHistoryPage } from "../chat-history";
import type { ConversationSummary } from "../conversation";

const { useConversationSession } = await import("./useConversationSession");
const { useStoryMessageActions } = await import("./useStoryMessageActions");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; onlineManager.setOnline(true); });
const summary = (id = 1, revision = 5): ConversationSummary => ({
	id, revision, name: `Chat ${id}`, authorNote: "", cast: [], control: { humanParticipantId: null, modelParticipantId: null },
	controlValidity: { valid: false, reason: "missing-seat" }, playable: false,
	capabilities: { compose: { available: false, reason: "conversation-not-playable" },
		generate: { available: false, reason: "conversation-not-playable" }, swipe: { available: false, reason: "conversation-not-playable" } }, activeGenerations: [],
});
const page = (id = 1, index = 1, revision = 5): ChatHistoryPage => ({
	conversationId: id, revision, name: `Chat ${id}`, cast: [],
	messages: Array.from({ length: 2 }, (_, i) => ({
		id: id * 100 + 7 - index * 2 + i, position: 7 - index * 2 + i, timestamp: "2026-01-01T00:00:00.000Z",
		modelParticipantIdAtCreation: null, continuable: false, swipe: { eligible: false as const, reason: "conversation-not-playable" as const }, author: null,
		variants: [{ id: 1000 + i, position: 1, content: "Before", selected: true, timestamp: "2026-01-01T00:00:00.000Z" }],
	})),
	page: { index, pageSize: 2, totalMessages: 6, totalPages: 3, hasOlder: index < 3, hasNewer: index > 1 },
});
type Request = { url: URL; init?: RequestInit };
async function harness(handler?: (request: Request) => Promise<Response>, strict = false) {
	const requests: Request[] = [];
	globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
		const request = { url: new URL(String(input)), init }; requests.push(request);
		const id = Number(request.url.pathname.split("/")[3]);
		return handler?.(request) ?? Promise.resolve(Response.json(request.url.pathname.endsWith("history") ? page(id) : summary(id)));
	}, { preconnect() {} });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
	const chat = (id: number) => ({ id: String(id), title: `Chat ${id}`, updatedAt: "", cast: [], excerpt: "" });
	const initialWorkspace = { activeChat: chat(1), chats: [chat(1), chat(2)], characters: [] };
	const actions: StoryAction[] = [];
	const hook = await renderHook(() => {
		const [story, dispatch] = useReducer(reduceStory, undefined, createStoryState);
		const dispatchStory = useCallback((action: StoryAction) => { actions.push(action); dispatch(action); }, []);
		const session = useConversationSession({ initialWorkspace, story, dispatchStory });
		const commands = useStoryMessageActions({
			signal: session.signal,
			story, conversation: session.conversation, dispatchStory, setConversation: session.setConversation,
			queueSwipeScroll() {}, clearPreviewError() {}, canEnterPreview: true, onEnterPreview() {},
		});
		return { ...session, ...commands, story };
	}, client, strict);
	Object.assign(window, { requestAnimationFrame: (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 0; } });
	await flushHook();
	return { hook, client, requests, actions, switchTo: async (id: number) => { await hook.act(async () => hook.current.selectChat(String(id))); await flushHook(); } };
}

test("switching Conversation aborts both open reads and rejects their late response", async () => {
	const late = Promise.withResolvers<Response>();
	const h = await harness(({ url }) => url.pathname.includes("/1") ? late.promise : Promise.resolve(Response.json(url.pathname.endsWith("history") ? page(2) : summary(2))));
	const signals = h.requests.map(({ init }) => init?.signal);
	await h.switchTo(2);
	expect(signals).toHaveLength(2);
	expect(signals.every((signal) => signal?.aborted)).toBe(true);
	await h.hook.act(async () => late.resolve(Response.json(summary())));
	await flushHook();
	expect(h.hook.current.conversation?.id).toBe(2);
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([205, 206]);
});

test("StrictMode, 21 summary readers, rerenders and reconnect issue one open pair and share writes", async () => {
	const { useConversationQuery } = await import("../conversation-query");
	let revision = 5;
	const h = await harness(({ url }) => Promise.resolve(Response.json(url.pathname.endsWith("history") ? page(1, 1, revision) : summary(1, revision))), true);
	const readers = await renderHook(() => Array.from({ length: 21 }, () => useConversationQuery(1)), h.client, true);
	for (let i = 0; i < 5; i++) { await h.hook.rerender(); await readers.rerender(); }
	expect(h.requests).toHaveLength(2);
	revision = 6;
	await h.hook.act(async () => h.hook.current.setConversation({ ...summary(1, 6), name: "Saved" }));
	await h.hook.act(async () => { onlineManager.setOnline(false); onlineManager.setOnline(true); });
	await flushHook();
	expect(readers.current.map(({ data }) => data?.name)).toEqual(Array(21).fill("Saved"));
	const later = await renderHook(() => useConversationQuery(1), h.client);
	expect(later.current.data?.revision).toBe(6);
	expect(h.hook.current.activeChat.title).toBe("Saved");
	expect(h.requests).toHaveLength(3);
});

for (const transition of ["unmount", "A to B to A"] as const) test(`a command settling after ${transition} cannot resurrect its Conversation owner`, async () => {
	const { runConversationCommand } = await import("../conversation-command-runner");
	const late = Promise.withResolvers<Response>();
	const h = await harness(({ url, init }) => {
		const id = Number(url.pathname.split("/")[3]);
		return init?.method === "POST" ? late.promise : Promise.resolve(Response.json(url.pathname.endsWith("history") ? page(id) : summary(id)));
	});
	const adopted = h.hook.current.setConversation;
	let command: Promise<void> = Promise.resolve();
	await h.hook.act(async () => {
		command = runConversationCommand({ conversationId: 1, revision: () => 5, onConversationChange: adopted, setNotice() {} }, { type: "rename-conversation", name: "Late" });
	});
	if (transition === "unmount") await h.hook.unmount();
	else { await h.switchTo(2); await h.switchTo(1); }
	await h.hook.act(async () => { late.resolve(Response.json({ outcome: "applied", conversation: { ...summary(1, 6), name: "Late" } })); await command; });
	await flushHook();
	const { useConversationQuery } = await import("../conversation-query");
	const reader = await renderHook(() => useConversationQuery(1), h.client);
	expect(reader.current.data?.name).toBe("Chat 1");
	if (transition !== "unmount") expect(h.hook.current.conversation?.revision).toBe(5);
});

test("commands use the current revision and a 409 publishes authority to every reader", async () => {
	const { runConversationCommand } = await import("../conversation-command-runner");
	const { useConversationQuery } = await import("../conversation-query");
	const h = await harness(({ url, init }) => Promise.resolve(init?.method === "POST"
		? Response.json({ outcome: "conflict", expectedRevision: 7, actualRevision: 9, currentConversation: summary(1, 9) }, { status: 409 })
		: Response.json(url.pathname.endsWith("history") ? page() : summary())));
	const reader = await renderHook(() => useConversationQuery(1), h.client);
	await h.hook.act(async () => h.hook.current.setConversation(summary(1, 7)));
	await flushHook();
	const notices: string[] = [];
	await h.hook.act(async () => runConversationCommand({
		conversationId: 1, revision: () => h.hook.current.conversation?.revision ?? null,
		onConversationChange: h.hook.current.setConversation, setNotice: (notice) => notices.push(notice),
	}, { type: "rename-conversation", name: "Local" }));
	await flushHook();
	expect(JSON.parse(String(h.requests.find(({ init }) => init?.method === "POST")?.init?.body))).toMatchObject({ expectedRevision: 7 });
	expect(h.hook.current.conversation?.revision).toBe(9);
	expect(reader.current.data?.revision).toBe(9);
	expect(notices).toEqual(["The Conversation changed elsewhere; the current Cast was loaded."]);
});

test("a late refresh cannot roll back a newer write or its history", async () => {
	const late = Promise.withResolvers<Response>();
	let historyReads = 0;
	const h = await harness(({ url }) => Promise.resolve(url.pathname.endsWith("history") ? (++historyReads === 1 ? Response.json(page()) : late.promise) : Response.json(summary())));
	let refresh: Promise<ConversationSummary | null> = Promise.resolve(null);
	await h.hook.act(async () => { refresh = h.hook.current.refreshStory(1).catch(() => null); });
	await flushHook();
	await h.hook.act(async () => h.hook.current.setConversation(summary(1, 8)));
	await h.hook.act(async () => { late.resolve(Response.json(page(1, 1, 5))); await refresh; });
	await flushHook();
	expect(h.hook.current.conversation?.revision).toBe(8);
	expect(h.actions.filter(({ type }) => type === "window-received")).toHaveLength(1);
});

test("a newer source position aborts the old window and never scrolls to its late result", async () => {
	const late = Promise.withResolvers<Response>();
	const h = await harness(({ url }) => Promise.resolve(url.pathname.endsWith("history")
		? url.searchParams.get("aroundMessageId") === "101" ? late.promise : Response.json(page(1, url.searchParams.has("aroundMessageId") ? 2 : 1))
		: Response.json(summary())));
	const scrolls: string[] = [];
	Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: (selector: string) => ({ scrollIntoView: () => scrolls.push(selector) }) } });
	let older: Promise<void> = Promise.resolve();
	await h.hook.act(async () => { older = h.hook.current.navigateToSourceMessage(101); });
	await flushHook();
	const oldSignal = h.requests.at(-1)?.init?.signal;
	await h.hook.act(async () => h.hook.current.navigateToSourceMessage(103));
	expect(oldSignal?.aborted).toBe(true);
	await h.hook.act(async () => { late.resolve(Response.json(page(1, 3))); await older; });
	await flushHook();
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([103, 104]);
	expect(scrolls).toEqual(['[data-message-id="103"]']);
});

test("paging follows the current edge and deduplicates rapid calls independently of window size", async () => {
	const h = await harness(({ url }) => {
		const around = Number(url.searchParams.get("aroundMessageId"));
		const index = Number(url.searchParams.get("page")) || (around === 103 ? 2 : 1);
		return Promise.resolve(Response.json(url.pathname.endsWith("history") ? page(1, index) : summary()));
	});
	let paging: Promise<void>[] = [];
	await h.hook.act(async () => { paging = [h.hook.current.loadMoreHistory(), h.hook.current.loadMoreHistory()]; await Promise.all(paging); });
	await flushHook();
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([103, 104, 105, 106]);
	expect(h.requests).toHaveLength(3);
	await h.hook.act(async () => h.hook.current.loadMoreHistory());
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([101, 102, 103, 104, 105, 106]);
	expect(h.requests).toHaveLength(4);
	for (let i = 0; i < 5; i++) await h.hook.rerender();
	expect(h.requests).toHaveLength(4);
});

test("newer paging extends a detached window and generation refresh retains that complete window", async () => {
	let refreshing = false;
	const h = await harness(({ url }) => {
		const around = Number(url.searchParams.get("aroundMessageId"));
		const index = Number(url.searchParams.get("page")) || (around <= 102 ? 3 : around <= 104 ? 2 : 1);
		return Promise.resolve(Response.json(url.pathname.endsWith("history") ? page(1, index, refreshing ? 6 : 5) : summary(1, refreshing ? 6 : 5)));
	});
	Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => null } });
	await h.hook.act(async () => h.hook.current.navigateToSourceMessage(101));
	await h.hook.act(async () => h.hook.current.loadMoreHistory("newer"));
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([101, 102, 103, 104]);
	expect(h.hook.current.story.page?.hasNewer).toBe(true);
	refreshing = true;
	const before = h.requests.length;
	await h.hook.act(async () => h.hook.current.refreshStory(1));
	await flushHook();
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([101, 102, 103, 104]);
	expect(h.hook.current.story.page?.hasNewer).toBe(true);
	expect(h.hook.current.story.revision).toBe(6);
	expect(h.requests.slice(before).map(({ url }) => url.search)).toEqual(["", "?page=2", "?page=3"]);
	await h.hook.act(async () => h.hook.current.loadMoreHistory("newer"));
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([101, 102, 103, 104, 105, 106]);
	expect(h.hook.current.story.page?.hasNewer).toBe(false);
});

test("source navigation cancels a refresh still reading the Conversation before it can fetch history", async () => {
	const late = Promise.withResolvers<Response>();
	let summaries = 0;
	const h = await harness(({ url }) => url.pathname.endsWith("history")
		? Promise.resolve(Response.json(page(1, url.searchParams.has("aroundMessageId") ? 3 : 1)))
		: ++summaries === 1 ? Promise.resolve(Response.json(summary())) : late.promise);
	let refresh: Promise<unknown> = Promise.resolve();
	await h.hook.act(async () => { refresh = h.hook.current.refreshStory(1).catch(() => null); });
	await flushHook();
	const refreshSignal = h.requests.at(-1)?.init?.signal;
	Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => null } });
	await h.hook.act(async () => h.hook.current.navigateToSourceMessage(101));
	expect(refreshSignal?.aborted).toBe(true);
	const count = h.requests.length;
	await h.hook.act(async () => { late.resolve(Response.json(summary())); await refresh; });
	expect(h.requests).toHaveLength(count);
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([101, 102]);
});

test("a source jump supersedes paging without allowing the old completion to extend its window", async () => {
	const late = Promise.withResolvers<Response>();
	const h = await harness(({ url }) => url.searchParams.get("page") === "2" ? late.promise
		: Promise.resolve(Response.json(url.pathname.endsWith("history") ? page(1, url.searchParams.has("aroundMessageId") ? 3 : 1) : summary())));
	let paging: Promise<void> = Promise.resolve();
	await h.hook.act(async () => { paging = h.hook.current.loadMoreHistory(); });
	const signal = h.requests.at(-1)?.init?.signal;
	Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => null } });
	await h.hook.act(async () => h.hook.current.navigateToSourceMessage(101));
	expect(signal?.aborted).toBe(true);
	await h.hook.act(async () => { late.resolve(Response.json(page(1, 2))); await paging; });
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([101, 102]);
	expect(h.hook.current.story.status).toBe("ready");
});

test("a Conversation switch during the render wait suppresses the old jump's scroll", async () => {
	const h = await harness();
	const frames: FrameRequestCallback[] = [];
	Object.assign(window, { requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; } });
	const scrolls: string[] = [];
	Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: (selector: string) => ({ scrollIntoView: () => scrolls.push(selector) }) } });
	let navigation: Promise<void> = Promise.resolve();
	await h.hook.act(async () => { navigation = h.hook.current.navigateToSourceMessage(105); });
	await h.switchTo(2);
	await h.hook.act(async () => { frames.shift()?.(0); frames.shift()?.(0); await navigation; });
	expect(scrolls).toEqual([]);
	expect(h.hook.current.story.conversationId).toBe(2);
});

test("jump to latest replaces a detached window and ensureLatest reads newly published authority immediately", async () => {
	const h = await harness(({ url }) => Promise.resolve(Response.json(
		url.pathname.endsWith("history") ? page(1, url.searchParams.has("aroundMessageId") ? 3 : 1) : summary(),
	)));
	const scrolls: number[] = [];
	Object.defineProperty(globalThis, "document", { configurable: true, value: {
		querySelector: (selector: string) => selector === ".story-scroll" ? { scrollHeight: 99, scrollTo: ({ top }: { top: number }) => scrolls.push(top) } : null,
	} });
	await h.hook.act(async () => h.hook.current.navigateToSourceMessage(101));
	await h.hook.act(async () => { expect((await h.hook.current.ensureLatest())?.revision).toBe(5); });
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([105, 106]);
	expect(scrolls).toEqual([99]);
	await h.hook.act(async () => { h.hook.current.setConversation(summary(1, 8)); expect((await h.hook.current.ensureLatest())?.revision).toBe(8); });
});

test("an old Stop mutation cannot settle a newer Stop after A to B to A", async () => {
	const { useGenerationController } = await import("./useGenerationController");
	const responses = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()];
	let stops = 0;
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
		if (String(input).endsWith("/stop")) return responses[stops++]!.promise;
		return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("Detached")), { once: true }));
	}, { preconnect() {} });
	let conversation = { ...summary(), activeGenerations: [{ generationId: 7, messageId: 105, variantId: 1005, startedAt: "2026-01-01T00:00:00.000Z" }] };
	const activeChatIdRef = { current: "1" };
	const dispatchStory = () => {};
	const hook = await renderHook(() => useGenerationController({
		conversation, story: { ...createStoryState(), conversationId: conversation.id }, dispatchStory, activeChatIdRef,
		refreshStory: async () => conversation, ensureLatest: async () => conversation, inspectPromptPlanBeforeGenerating: false,
	}), client);
	let older: Promise<void> = Promise.resolve();
	await hook.act(async () => { older = hook.current.stopGeneration(7); });
	await hook.act(async () => { hook.current.conversationSwitched(); conversation = { ...conversation, id: 2 }; activeChatIdRef.current = "2"; });
	await hook.rerender();
	await hook.act(async () => { hook.current.conversationSwitched(); conversation = { ...conversation, id: 1 }; activeChatIdRef.current = "1"; });
	await hook.rerender();
	let newer: Promise<void> = Promise.resolve();
	await hook.act(async () => { newer = hook.current.stopGeneration(7); });
	expect(stops).toBe(2);
	expect(hook.current.stopPending).toBe(true);
	await hook.act(async () => { responses[0]!.resolve(Response.json({ outcome: "stopped", generationId: 7 })); await older; });
	expect(hook.current.stopPending).toBe(true);
	await hook.act(async () => { responses[1]!.resolve(Response.json({ outcome: "stopped", generationId: 7 })); await newer; });
	expect(hook.current.stopPending).toBe(false);
	await hook.unmount();
	client.clear();
});

test("publication aborts a late summary read and every reader retains the newer revision", async () => {
	const { conversationKey, useConversationQuery } = await import("../conversation-query");
	const late = Promise.withResolvers<Response>();
	let reads = 0;
	const h = await harness(({ url }) => url.pathname.endsWith("history") ? Promise.resolve(Response.json(page()))
		: ++reads === 1 ? Promise.resolve(Response.json(summary())) : late.promise);
	await h.hook.act(async () => { void h.client.invalidateQueries({ queryKey: conversationKey(1) }); });
	const signal = h.requests.at(-1)?.init?.signal;
	await h.hook.act(async () => h.hook.current.setConversation(summary(1, 8)));
	expect(signal?.aborted).toBe(true);
	await h.hook.act(async () => late.resolve(Response.json(summary())));
	await flushHook();
	expect(h.hook.current.conversation?.revision).toBe(8);
	const reader = await renderHook(() => useConversationQuery(1), h.client);
	expect(reader.current.data?.revision).toBe(8);
});

test("reopening after a write and late refresh fetches fresh history and never displays the old cached page", async () => {
	const late = Promise.withResolvers<Response>();
	const fresh = Promise.withResolvers<Response>();
	let reads = 0;
	const history = () => ++reads === 1 ? Promise.resolve(Response.json(page())) : (reads === 2 ? late : fresh).promise.then((response) => response.clone());
	const h = await harness(({ url }) => url.pathname.endsWith("history") ? history() : Promise.resolve(Response.json(summary())));
	let refresh: Promise<ConversationSummary | null> = Promise.resolve(null);
	await h.hook.act(async () => { refresh = h.hook.current.refreshStory(1).catch(() => null); });
	await flushHook();
	await h.hook.act(async () => h.hook.current.setConversation(summary(1, 8)));
	await h.hook.act(async () => { late.resolve(Response.json(page())); });
	await h.hook.unmount();
	await refresh;
	const activeChat = { id: "1", title: "Chat", updatedAt: "", cast: [], excerpt: "" };
	const reopened = await renderHook(() => {
		const [story, dispatchStory] = useReducer(reduceStory, undefined, createStoryState);
		const session = useConversationSession({ initialWorkspace: { activeChat, chats: [activeChat], characters: [] }, story, dispatchStory });
		return { session, story };
	}, h.client);
	await flushHook();
	expect(reads).toBeGreaterThanOrEqual(3);
	expect(reopened.current.story.messages).toEqual([]);
	await reopened.act(async () => fresh.resolve(Response.json(page(1, 1, 8))));
	await flushHook();
	expect(reopened.current.story.revision).toBe(8);
	expect(reopened.current.story.messages.map(({ id }) => id)).toEqual([105, 106]);
});

test("Delete settling after A to B to A cannot remove a replacement Story Message", async () => {
	const late = Promise.withResolvers<Response>();
	const h = await harness(({ url, init }) => {
		const id = Number(url.pathname.split("/")[3]);
		return init?.method === "POST" ? late.promise : Promise.resolve(Response.json(url.pathname.endsWith("history") ? page(id) : summary(id)));
	});
	let command = Promise.resolve();
	await h.hook.act(async () => { command = h.hook.current.deleteStoryMessage(105); });
	await h.switchTo(2);
	await h.switchTo(1);
	await h.hook.act(async () => { late.resolve(Response.json({ outcome: "applied", conversation: summary(1, 6) })); await command; });
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([105, 106]);
	expect(h.hook.current.conversation?.revision).toBe(5);
});

test("an older history response cannot replace a newer cached window", async () => {
	let stale = false;
	const h = await harness(({ url }) => {
		const history = page(1, 1, stale ? 6 : 8);
		if (stale) history.messages[0]!.variants[0]!.content = "Obsolete edit";
		return Promise.resolve(Response.json(url.pathname.endsWith("history") ? history : summary(1, 8)));
	});
	stale = true;
	await h.hook.act(async () => h.hook.current.refreshStory(1));
	await flushHook();
	expect(h.hook.current.story.revision).toBe(8);
	expect(h.hook.current.story.messages[0]?.swipes[0]?.content).toBe("Before");
});

test("a deleted source anchor returns to the latest history", async () => {
	let deleted = false;
	const h = await harness(({ url }) => Promise.resolve(url.pathname.endsWith("history")
		? url.searchParams.has("aroundMessageId") && deleted ? Response.json({ outcome: "not-found" }, { status: 404 })
			: Response.json(page(1, url.searchParams.has("aroundMessageId") ? 3 : 1, deleted ? 6 : 5))
		: Response.json(summary(1, deleted ? 6 : 5))));
	Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => null } });
	await h.hook.act(async () => h.hook.current.navigateToSourceMessage(101));
	deleted = true;
	await h.hook.act(async () => h.hook.current.refreshStory(1));
	await flushHook();
	await flushHook();
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([105, 106]);
	expect(h.hook.current.story.page?.hasNewer).toBe(false);
	expect(h.hook.current.story.revision).toBe(6);
});

test("initial history behind Conversation authority refetches and finishes opening", async () => {
	const fresh = Promise.withResolvers<Response>();
	let reads = 0;
	const h = await harness(({ url }) => url.pathname.endsWith("history")
		? ++reads === 1 ? Promise.resolve(Response.json(page())) : fresh.promise
		: Promise.resolve(Response.json(summary(1, 6))), true);
	for (let i = 0; i < 5; i++) await h.hook.rerender();
	expect(reads).toBe(2);
	expect(h.hook.current.story.status).toBe("loading-first");
	await h.hook.act(async () => fresh.resolve(Response.json(page(1, 1, 6))));
	await flushHook();
	expect(h.hook.current.story.status).toBe("ready");
	expect(h.hook.current.story.revision).toBe(6);
	expect(h.requests).toHaveLength(3);
});

test("refresh adopts the authoritative latest page, dropping Messages deleted on the server", async () => {
	const latest = page(1, 1, 6);
	const afterDelete = { ...latest, messages: [page(1, 2, 6).messages[1], latest.messages[0]] };
	let refreshed = false;
	const h = await harness(({ url }) => Promise.resolve(url.pathname.endsWith("history")
		? Response.json(refreshed ? afterDelete : page())
		: Response.json(summary(1, refreshed ? 6 : 5))));
	refreshed = true;
	await h.hook.act(async () => { await h.hook.current.refreshStory(1); });
	await flushHook();
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([104, 105]);
});

test("navigation to a visible Message cancels paging and permits another older page", async () => {
	const late = Promise.withResolvers<Response>();
	let reads = 0;
	const h = await harness(({ url }) => url.searchParams.get("page") === "2" && ++reads === 1 ? late.promise
		: Promise.resolve(Response.json(url.pathname.endsWith("history") ? page(1, Number(url.searchParams.get("page")) || 1) : summary())));
	Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => null } });
	let paging = Promise.resolve();
	await h.hook.act(async () => { paging = h.hook.current.loadMoreHistory(); });
	await flushHook();
	const signal = h.requests.at(-1)?.init?.signal;
	await h.hook.act(async () => h.hook.current.navigateToSourceMessage(105));
	expect(signal?.aborted).toBe(true);
	expect(h.hook.current.story.status).toBe("ready");
	await h.hook.act(async () => { late.resolve(Response.json(page(1, 2))); await paging; });
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([105, 106]);
	await h.hook.act(async () => h.hook.current.loadMoreHistory());
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([103, 104, 105, 106]);
});

test("batched A to B to A selection creates a usable replacement owner", async () => {
	const h = await harness();
	const oldPublication = h.hook.current.setConversation;
	const oldSignal = h.hook.current.signal;
	await h.hook.act(async () => { h.hook.current.selectChat("2"); h.hook.current.selectChat("1"); });
	await flushHook();
	expect(oldSignal.aborted).toBe(true);
	expect(h.hook.current.signal.aborted).toBe(false);
	await h.hook.act(async () => { oldPublication(summary(1, 9)); h.hook.current.setConversation(summary(1, 6)); });
	await flushHook();
	expect(h.hook.current.conversation?.revision).toBe(6);
});
