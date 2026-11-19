import { historyVariant, historyMessage, historyPage, conversationSummary, installFetch } from "../test-fixtures/conversation";
import type { StoryState } from "../story";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { QueryClient, onlineManager } from "@tanstack/react-query";
import { flushHook, renderHook } from "../test-fixtures/render-hook";
import { createStoryOverlays, displayedVariantId, readStory } from "../story";
import type { ChatHistoryPage } from "../chat-history";
import type { ConversationSummary } from "../conversation";

const { useConversationSession } = await import("./useConversationSession");
const { useStoryMessageActions } = await import("./useStoryMessageActions");
const originalFetch = globalThis.fetch;
let originalDocument: PropertyDescriptor | undefined;
beforeEach(() => { originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document"); });
afterEach(() => {
	globalThis.fetch = originalFetch;
	onlineManager.setOnline(true);
	if (originalDocument === undefined) Reflect.deleteProperty(globalThis, "document");
	else Object.defineProperty(globalThis, "document", originalDocument);
});
const summary = (id = 1, revision = 5): ConversationSummary => conversationSummary({ id, revision, name: `Chat ${id}` });
const page = (id = 1, index = 1, revision = 5): ChatHistoryPage => historyPage({
	conversationId: id,
	revision,
	name: `Chat ${id}`,
	cast: [],
	messages: Array.from({ length: 2 }, (_, i) => historyMessage({
		id: id * 100 + 7 - index * 2 + i,
		position: 7 - index * 2 + i,
		authorRole: null,
		continuable: false,
		swipe: { eligible: false, reason: "conversation-not-playable" },
		author: null,
		variants: [historyVariant({ id: 1000 + i, content: "Before" })],
	})),
	page: { index, totalMessages: 6, totalPages: 3, hasOlder: index < 3, hasNewer: index > 1 },
});
type Request = { url: URL; init?: RequestInit };
async function harness(handler?: (request: Request) => Promise<Response>, strict = false) {
	const requests: Request[] = [];
	installFetch((input: RequestInfo | URL, init?: RequestInit) => {
		const request = { url: new URL(String(input)), init }; requests.push(request);
		const id = Number(request.url.pathname.split("/")[3]);
		return handler?.(request) ?? Promise.resolve(Response.json(request.url.pathname.endsWith("history") ? page(id) : summary(id)));
	});
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
	const hook = await renderHook(() => {
		const session = useConversationSession({ initialChatId: "1" });
		const commands = useStoryMessageActions({
			signal: session.signal, story: session.story, conversation: session.conversation,
			dispatchStory: session.dispatchStory, setConversation: session.setConversation,
			queueSwipeScroll() {}, canEnterPreview: true, onEnterPreview: (enter) => enter(),
		});
		return { ...session, ...commands };
	}, client, strict);
	Object.assign(window, { requestAnimationFrame: (callback: FrameRequestCallback) => { queueMicrotask(() => callback(0)); return 0; } });
	await flushHook();
	return { hook, client, requests, switchTo: async (id: number) => { await hook.act(async () => hook.current.selectChat(String(id))); await flushHook(); } };
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
	expect(h.hook.current.activeChatTitle).toBe("Saved");
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
	let command: Promise<boolean> = Promise.resolve(true);
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
		? Response.json({ outcome: "conflict", reason: "stale-revision", expectedRevision: 7, actualRevision: 9, current: summary(1, 9) }, { status: 409 })
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
	const h = await harness(({ url }) => {
		if (!url.pathname.endsWith("history")) return Promise.resolve(Response.json(summary()));
		if (++historyReads === 1) return Promise.resolve(Response.json(page()));
		return late.promise.then((response) => response.clone());
	});
	let refresh: Promise<ConversationSummary | null> = Promise.resolve(null);
	await h.hook.act(async () => { refresh = h.hook.current.refreshStory(1).catch(() => null); });
	await flushHook();
	await h.hook.act(async () => h.hook.current.setConversation(summary(1, 8)));
	await h.hook.act(async () => { late.resolve(Response.json(page(1, 1, 5))); await refresh; });
	await flushHook();
	expect(h.hook.current.conversation?.revision).toBe(8);
	expect(readyStory(h.hook.current.story).revision).toBe(5);
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

test("a failed source jump leaves the current transcript readable", async () => {
	const h = await harness(({ url }) => Promise.resolve(url.searchParams.has("aroundMessageId")
		? Response.json({ error: "Server bug" }, { status: 500 })
		: Response.json(url.pathname.endsWith("history") ? page() : summary())));
	await h.hook.act(async () => {
		await expect(h.hook.current.navigateToSourceMessage(101)).rejects.toBeInstanceOf(Error);
	});
	await flushHook();
	expect(h.hook.current.story.status).toBe("ready");
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([105, 106]);
});

test("a failed off-window jump leaves the applied write's history refresh running", async () => {
	const fresh = Promise.withResolvers<Response>();
	let written = false;
	const h = await harness(async ({ url }) => {
		if (url.searchParams.has("aroundMessageId")) return Response.json({ error: "Server bug" }, { status: 500 });
		if (!url.pathname.endsWith("history")) return Response.json(summary());
		return written ? fresh.promise.then((response) => response.clone()) : Response.json(page());
	});
	written = true;
	await h.hook.act(async () => h.hook.current.setConversation(summary(1, 6)));
	await flushHook();
	await h.hook.act(async () => { await expect(h.hook.current.navigateToSourceMessage(101)).rejects.toBeInstanceOf(Error); });
	await flushHook();
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([105, 106]);
	await h.hook.act(async () => fresh.resolve(Response.json(page(1, 1, 6))));
	await flushHook();
	expect(readyStory(h.hook.current.story).revision).toBe(6);
});

test("a failed source jump leaves an earlier source read eligible to commit", async () => {
	const earlier = Promise.withResolvers<Response>();
	const h = await harness(async ({ url }) => {
		if (!url.pathname.endsWith("history")) return Response.json(summary());
		const source = url.searchParams.get("aroundMessageId");
		if (source === "101") return earlier.promise;
		if (source === "103") return Response.json({ outcome: "not-found" }, { status: 404 });
		return Response.json(page());
	});
	Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => null } });
	let jump = Promise.resolve();
	await h.hook.act(async () => { jump = h.hook.current.navigateToSourceMessage(101); });
	await h.hook.act(async () => h.hook.current.navigateToSourceMessage(103).catch(() => undefined));
	await flushHook();
	expect(readyStory(h.hook.current.story).historyFailed).toBe(true);
	await h.hook.act(async () => { earlier.resolve(Response.json(page(1, 3))); await jump; });
	await flushHook();
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([101, 102]);
});

test("a write-triggered refresh retries a stale page and shows the applied revision", async () => {
	let historyReads = 0;
	const h = await harness(async ({ url }) => Response.json(url.pathname.endsWith("history")
		? page(1, 1, ++historyReads > 2 ? 6 : 5) : summary()));
	await h.hook.act(async () => h.hook.current.setConversation(summary(1, 6)));
	await flushHook();
	expect(readyStory(h.hook.current.story).revision).toBe(6);
});

test("a write during refresh completion gets its own current transcript", async () => {
	let revision = 5;
	const h = await harness(async ({ url }) => Response.json(url.pathname.endsWith("history") ? page(1, 1, revision) : summary(1, revision)));
	const unsubscribe = h.client.getQueryCache().subscribe((event) => {
		if (revision !== 5 || event.type !== "updated" || event.action.type !== "success" || event.query.queryKey[0] !== "history-window") return;
		revision = 6;
		h.hook.current.setConversation(summary(1, revision));
	});
	try {
		await h.hook.act(async () => h.hook.current.refreshStory(1));
		await flushHook();
		expect(h.hook.current.conversation?.revision).toBe(6);
		expect(readyStory(h.hook.current.story).revision).toBe(6);
	} finally { unsubscribe(); }
});

test("a source jump cannot replace the displayed window with an older revision", async () => {
	let summaryReads = 0;
	const h = await harness(async ({ url }) => Response.json(url.pathname.endsWith("history")
		? url.searchParams.has("aroundMessageId") ? page(1, 3, 5) : page(1, 1, 6)
		: summary(1, ++summaryReads === 1 ? 5 : 6)));
	Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => null } });
	expect(readyStory(h.hook.current.story).revision).toBe(6);
	await h.hook.act(async () => h.hook.current.navigateToSourceMessage(101).catch(() => undefined));
	await flushHook();
	expect(readyStory(h.hook.current.story).revision).toBe(6);
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([105, 106]);
	expect(readyStory(h.hook.current.story).historyFailed).toBe(true);
});

test("Delete uses the newer Conversation Summary after a source jump", async () => {
	let revision = 5;
	const h = await harness(async ({ url, init }) => {
		if (init?.method === "POST") return Response.json({ outcome: "invalid", reason: "Test command" }, { status: 422 });
		if (!url.pathname.endsWith("history")) return Response.json(summary(1, revision));
		if (url.searchParams.has("aroundMessageId")) { revision = 6; return Response.json(page(1, 3, 6)); }
		return Response.json(page());
	});
	Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => null } });
	await h.hook.act(async () => h.hook.current.navigateToSourceMessage(101));
	await flushHook();
	await h.hook.act(async () => h.hook.current.deleteStoryMessage(101));
	const command = h.requests.find(({ init }) => init?.method === "POST");
	expect(JSON.parse(String(command?.init?.body))).toMatchObject({ expectedRevision: 6, action: { type: "delete-message", messageId: 101 } });
});

test("a history refresh that returns 404 reports failure and keeps the loaded transcript", async () => {
	let missing = false;
	const h = await harness(async ({ url }) => {
		if (!url.pathname.endsWith("history")) return Response.json(summary());
		return missing ? Response.json({ outcome: "not-found" }, { status: 404 }) : Response.json(page());
	});
	missing = true;
	await h.hook.act(async () => h.hook.current.refreshStory(1).catch(() => null));
	await flushHook();
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([105, 106]);
	expect(readyStory(h.hook.current.story).historyFailed).toBe(true);
});

test("paging follows the current edge and deduplicates rapid calls independently of window size", async () => {
	const h = await harness(({ url }) => {
		const around = Number(url.searchParams.get("aroundMessageId"));
		const index = Number(url.searchParams.get("page")) || (around === 103 ? 2 : 1);
		return Promise.resolve(Response.json(url.pathname.endsWith("history") ? page(1, index) : summary()));
	});
	const first = h.hook.current.story.messages[0];
	let paging: Promise<void>[] = [];
	await h.hook.act(async () => { paging = [h.hook.current.loadMoreHistory(), h.hook.current.loadMoreHistory()]; await Promise.all(paging); });
	await flushHook();
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([103, 104, 105, 106]);
	expect(h.requests).toHaveLength(3);
	expect(h.hook.current.story.messages[2]).toBe(first);
	await h.hook.act(async () => h.hook.current.loadMoreHistory());
	await flushHook();
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
	await flushHook();
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([101, 102, 103, 104]);
	expect(readyStory(h.hook.current.story).page.hasNewer).toBe(true);
	refreshing = true;
	const before = h.requests.length;
	await h.hook.act(async () => h.hook.current.refreshStory(1));
	await flushHook();
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([101, 102, 103, 104]);
	expect(readyStory(h.hook.current.story).page.hasNewer).toBe(true);
	expect(readyStory(h.hook.current.story).revision).toBe(6);
	expect(h.requests.slice(before).map(({ url }) => url.search)).toEqual(["", "?page=2", "?page=3"]);
	await h.hook.act(async () => h.hook.current.loadMoreHistory("newer"));
	await flushHook();
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([101, 102, 103, 104, 105, 106]);
	expect(readyStory(h.hook.current.story).page.hasNewer).toBe(false);
});

test("a reload discards the local Preview even when React Query still has history", async () => {
	const history = page();
	history.messages[0]?.variants.push(historyVariant({ id: 1099, position: 2, selected: false }));
	const h = await harness(({ url }) => Promise.resolve(Response.json(url.pathname.endsWith("history") ? history : summary())));
	const message = h.hook.current.story.messages[0]!;
	await h.hook.act(async () => h.hook.current.selectSwipe(message.id, 1099));
	expect(displayedVariantId(h.hook.current.story, message)).toBe(1099);
	expect(h.requests.some(({ init }) => init?.method === "POST")).toBe(false);

	await h.hook.unmount();
	const reopened = await renderHook(() => useConversationSession({ initialChatId: "1" }), h.client);
	await flushHook();
	const reopenedStory = reopened.current.story;
	expect(displayedVariantId(reopenedStory, reopenedStory.messages[0]!)).toBe(1000);
	expect(reopenedStory.preview).toBeNull();
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
	await flushHook();
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

test("a Conversation write supersedes a pending older page at the latest anchor", async () => {
	const late = Promise.withResolvers<Response>();
	const fresh = Promise.withResolvers<Response>();
	let written = false;
	const h = await harness(async ({ url }) => {
		if (!url.pathname.endsWith("history")) return Response.json(summary());
		if (url.searchParams.get("page") === "2") return late.promise;
		return written ? fresh.promise.then((response) => response.clone()) : Response.json(page());
	});
	let paging = Promise.resolve();
	await h.hook.act(async () => { paging = h.hook.current.loadMoreHistory(); });
	const pending = h.requests.at(-1);
	expect(pending?.url.search).toBe("?page=2");
	written = true;
	await h.hook.act(async () => h.hook.current.setConversation(summary(1, 6)));
	await h.hook.act(async () => late.resolve(Response.json(page(1, 2))));
	await flushHook();
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([105, 106]);
	await h.hook.act(async () => { fresh.resolve(Response.json(page(1, 1, 6))); await paging; });
	await flushHook();
	expect(readyStory(h.hook.current.story).revision).toBe(6);
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([105, 106]);
});

test("jumping to a visible Message preserves the history refresh from an applied write", async () => {
	const fresh = Promise.withResolvers<Response>();
	let written = false;
	const h = await harness(async ({ url }) => {
		if (!url.pathname.endsWith("history")) return Response.json(summary());
		return written ? fresh.promise : Response.json(page());
	});
	written = true;
	await h.hook.act(async () => h.hook.current.setConversation(summary(1, 6)));
	await flushHook();
	expect(h.hook.current.conversation?.revision).toBe(6);
	Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => null } });
	await h.hook.act(async () => h.hook.current.navigateToSourceMessage(105));
	const updated = page(1, 1, 6);
	updated.messages[0]!.variants[0]!.content = "Applied edit";
	await h.hook.act(async () => fresh.resolve(Response.json(updated)));
	await flushHook();
	expect(readyStory(h.hook.current.story).revision).toBe(6);
	expect(h.hook.current.story.messages[0]?.swipes[0]?.content).toBe("Applied edit");
});

test("refresh retries a history page older than the Conversation revision", async () => {
	let historyReads = 0;
	const h = await harness(async ({ url }) => Response.json(url.pathname.endsWith("history")
		? page(1, 1, [6, 5, 7][historyReads++] ?? 7) : summary(1, historyReads >= 3 ? 7 : 6)));
	await h.hook.act(async () => h.hook.current.refreshStory(1));
	await flushHook();
	expect(readyStory(h.hook.current.story).revision).toBe(7);
});

test("refresh restarts from the first page when the revision changes mid-window", async () => {
	let refreshing = false;
	let revision = 5;
	const h = await harness(async ({ url }) => {
		if (!url.pathname.endsWith("history")) return Response.json(summary(1, revision));
		const index = Number(url.searchParams.get("page"));
		if (refreshing && index === 2) revision = 6;
		const result = page(1, index, revision);
		result.messages[0]!.variants[0]!.content = `Revision ${revision}`;
		return Response.json(result);
	});
	await h.hook.act(async () => h.hook.current.loadMoreHistory());
	await flushHook();
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([103, 104, 105, 106]);
	refreshing = true;
	await h.hook.act(async () => h.hook.current.refreshStory(1));
	await flushHook();
	expect(readyStory(h.hook.current.story).revision).toBe(6);
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([103, 104, 105, 106]);
	expect(h.hook.current.story.messages.filter(({ id }) => id === 103 || id === 105).map((message) => message.swipes[0]?.content)).toEqual(["Revision 6", "Revision 6"]);
});

for (const direction of ["older", "newer"] as const) {
	test(`a late ${direction} page from another revision cannot extend the current window`, async () => {
		const adjacent = direction === "older" ? 3 : 1;
		const late = Promise.withResolvers<Response>();
		const fresh = Promise.withResolvers<Response>();
		let holdPage = false;
		let revision = 5;
		const h = await harness(({ url }) => {
			if (!url.pathname.endsWith("history")) return Promise.resolve(Response.json(summary(1, revision)));
			if (url.searchParams.has("aroundMessageId")) return revision === 5 ? Promise.resolve(Response.json(page(1, 2))) : fresh.promise;
			const index = Number(url.searchParams.get("page"));
			return holdPage && index === adjacent ? late.promise : Promise.resolve(Response.json(page(1, index, revision)));
		});
		Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => null } });
		await h.hook.act(async () => h.hook.current.navigateToSourceMessage(103));
		holdPage = true;
		let paging = Promise.resolve();
		await h.hook.act(async () => { paging = h.hook.current.loadMoreHistory(direction); });
		expect(h.requests.at(-1)?.url.search).toBe(`?page=${adjacent}`);

		revision = 6;
		holdPage = false;
		await h.hook.act(async () => late.resolve(Response.json(page(1, adjacent, 6))));
		await flushHook();
		expect(h.requests.at(-1)?.url.search).toBe("?aroundMessageId=103");
		expect(readyStory(h.hook.current.story).revision).toBe(5);
		expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([103, 104]);

		await h.hook.act(async () => { fresh.resolve(Response.json(page(1, 2, 6))); await paging; });
		await flushHook();
		expect(readyStory(h.hook.current.story).revision).toBe(6);
		expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([103, 104]);

		await h.hook.act(async () => h.hook.current.loadMoreHistory(direction));
		await flushHook();
		expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual(direction === "older" ? [101, 102, 103, 104] : [103, 104, 105, 106]);
	});
}

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
	expect(readyStory(h.hook.current.story).conversationId).toBe(2);
});

test("jump to latest replaces a detached window and ensureLatest reads newly published authority immediately", async () => {
	const h = await harness(({ url }) => Promise.resolve(Response.json(
		url.pathname.endsWith("history") ? page(1, url.searchParams.has("aroundMessageId") ? 3 : 1) : summary(),
	)));
	const scrolls: number[] = [];
	Object.defineProperty(globalThis, "document", { configurable: true, value: {
		querySelector: (selector: string) => selector === ".story-scroll" ? { scrollHeight: 99, scrollTo: ({ top }: { top: number }) => scrolls.push(top) } : null,
	} });
	const ensureLatest = h.hook.current.ensureLatest;
	await h.hook.act(async () => h.hook.current.navigateToSourceMessage(101));
	await h.hook.act(async () => { expect((await ensureLatest())?.revision).toBe(5); });
	await flushHook();
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([105, 106]);
	expect(scrolls).toEqual([99]);
	await h.hook.act(async () => { h.hook.current.setConversation(summary(1, 8)); expect((await h.hook.current.ensureLatest())?.revision).toBe(8); });
});

test.each([500, 404])("jump to latest reports a %i and keeps the detached transcript", async (status) => {
	let unavailable = false;
	const h = await harness(async ({ url }) => {
		if (!url.pathname.endsWith("history")) return Response.json(summary());
		if (url.searchParams.has("aroundMessageId")) return Response.json(page(1, 3));
		return unavailable ? Response.json(status === 404 ? { outcome: "not-found" } : { error: "Server bug" }, { status }) : Response.json(page());
	});
	Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => null } });
	await h.hook.act(async () => h.hook.current.navigateToSourceMessage(101));
	unavailable = true;
	await h.hook.act(async () => { await expect(h.hook.current.jumpToLatest()).rejects.toBeInstanceOf(Error); });
	expect(readyStory(h.hook.current.story).historyFailed).toBe(true);
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([101, 102]);

	unavailable = false;
	await h.hook.act(async () => h.hook.current.jumpToLatest());
	expect(readyStory(h.hook.current.story).historyFailed).toBe(false);
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([105, 106]);
});

test("an old Stop mutation cannot settle a newer Stop after A to B to A", async () => {
	const { useGenerationController } = await import("./useGenerationController");
	const responses = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()];
	let stops = 0;
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	installFetch((input: RequestInfo | URL, init?: RequestInit) => {
		if (String(input).endsWith("/stop")) return responses[stops++]!.promise;
		return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("Detached")), { once: true }));
	});
	let conversation = { ...summary(), activeGenerations: [{ generationId: 7, messageId: 105, variantId: 1005, startedAt: "2026-01-01T00:00:00.000Z" }] };
	const activeChatIdRef = { current: "1" };
	const dispatchStory = () => {};
	let visit = new AbortController();
	const reselect = () => { visit.abort(); visit = new AbortController(); };
	const hook = await renderHook(() => useGenerationController({
		signal: visit.signal, conversation, story: readStory({ overlays: createStoryOverlays(), window: null, conversationId: conversation.id, historyFailed: false, loadingMore: false }), dispatchStory, activeChatIdRef,
		refreshStory: async () => conversation, ensureLatest: async () => conversation, beforeInspect: (inspect) => inspect(),
		inspectPromptPlanBeforeGenerating: false,
	}), client);
	let older: Promise<void> = Promise.resolve();
	await hook.act(async () => { older = hook.current.stopGeneration(7); });
	await hook.act(async () => { hook.current.conversationSwitched(); reselect(); conversation = { ...conversation, id: 2 }; activeChatIdRef.current = "2"; });
	await hook.rerender();
	await hook.act(async () => { hook.current.conversationSwitched(); reselect(); conversation = { ...conversation, id: 1 }; activeChatIdRef.current = "1"; });
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
	const reopened = await renderHook(() => useConversationSession({ initialChatId: "1" }), h.client);
	await flushHook();
	expect(reads).toBeGreaterThanOrEqual(3);
	expect(reopened.current.story.messages).toEqual([]);
	await reopened.act(async () => fresh.resolve(Response.json(page(1, 1, 8))));
	await flushHook();
	expect(readyStory(reopened.current.story).revision).toBe(8);
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

test("refresh stops retrying stale pages and keeps the newer cached window", async () => {
	let stale = false;
	const h = await harness(({ url }) => {
		const history = page(1, 1, stale ? 6 : 8);
		if (stale) history.messages[0]!.variants[0]!.content = "Obsolete edit";
		return Promise.resolve(Response.json(url.pathname.endsWith("history") ? history : summary(1, 8)));
	});
	stale = true;
	await h.hook.act(async () => { await expect(h.hook.current.refreshStory(1)).rejects.toBeInstanceOf(Error); });
	await flushHook();
	expect(h.requests.filter(({ url }) => url.pathname.endsWith("history"))).toHaveLength(4);
	expect(readyStory(h.hook.current.story).revision).toBe(8);
	expect(h.hook.current.story.messages[0]?.swipes[0]?.content).toBe("Before");
});

test("refresh reports a deleted source anchor and keeps the detached transcript", async () => {
	let deleted = false;
	const h = await harness(({ url }) => Promise.resolve(url.pathname.endsWith("history")
		? url.searchParams.has("aroundMessageId") && deleted ? Response.json({ outcome: "not-found" }, { status: 404 })
			: Response.json(page(1, url.searchParams.has("aroundMessageId") ? 3 : 1, deleted ? 6 : 5))
		: Response.json(summary(1, deleted ? 6 : 5))));
	Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => null } });
	await h.hook.act(async () => h.hook.current.navigateToSourceMessage(101));
	deleted = true;
	await h.hook.act(async () => { await expect(h.hook.current.refreshStory(1)).rejects.toBeInstanceOf(Error); });
	await flushHook();
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([101, 102]);
	expect(readyStory(h.hook.current.story).historyFailed).toBe(true);
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
	expect(readyStory(h.hook.current.story).revision).toBe(6);
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
	await flushHook();
	expect(h.hook.current.story.messages.map(({ id }) => id)).toEqual([105, 106]);
	await h.hook.act(async () => h.hook.current.loadMoreHistory());
	await flushHook();
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

function readyStory(state: StoryState) {
	if (state.status !== "ready") throw new Error("Story was not ready.");
	return state;
}
