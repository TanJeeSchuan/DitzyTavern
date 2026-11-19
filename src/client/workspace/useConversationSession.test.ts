import { historyMessage, historyPage, conversationSummary, installFetch } from "../test-fixtures/conversation";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { flushHook, renderHook } from "../test-fixtures/render-hook";
import { NetworkError } from "../lib/request-outcome";
import type { ChatHistoryPage } from "../chat-history";
import type { ConversationSummary } from "../conversation";

const originalFetch = globalThis.fetch;
const { useConversationSession } = await import("./useConversationSession");

afterEach(() => {
	globalThis.fetch = originalFetch;
});

interface HistoryRefreshResult { conversation: ConversationSummary | null; failure?: unknown }

async function historyRefresh(historyResponse: () => Promise<Response>) {
	const conversation: ConversationSummary = conversationSummary({ name: "Chat", revision: 1 });
	let refreshing = false;
	installFetch(async (input: RequestInfo | URL) =>
		String(input).includes("/history") ? refreshing ? historyResponse() : Response.json({ outcome: "not-found" }, { status: 404 }) : Response.json(conversation));
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const hook = await renderHook(() => useConversationSession({ initialChatId: "1" }), client);
	await flushHook();
	refreshing = true;
	const result: HistoryRefreshResult = { conversation: null };
	await hook.act(async () => {
		try { result.conversation = await hook.current.refreshStory(1); } catch (error) { result.failure = error; }
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	await flushHook();
	const { story } = hook.current;
	await hook.unmount();
	client.clear();
	if (result.failure) throw result.failure;
	return { conversation: result.conversation, story };
}

describe("history refresh error classification", () => {
	test("a valid history page refreshes the Conversation", async () => {
		const page: ChatHistoryPage = historyPage({
			conversationId: 1,
			name: "Chat",
			revision: 1,
			cast: [],
			messages: [historyMessage({
				id: 11,
				authorRole: null,
				continuable: false,
				swipe: { eligible: false, reason: "conversation-not-playable" },
				author: null,
				variants: [],
			})],
			page: { pageSize: 10, totalMessages: 1, totalPages: 1, hasOlder: false },
		});
		const { conversation, story } = await historyRefresh(async () => Response.json(page));
		expect(conversation?.id).toBe(1);
		expect(story.messages.map(({ id }) => id)).toEqual([11]);
	});

	test("a missing history page still returns the refreshed Conversation without applying a page", async () => {
		const missing = mock(async () => Response.json({ outcome: "not-found" }, { status: 404 }));
		const { conversation, story } = await historyRefresh(missing);
		expect(missing).toHaveBeenCalledTimes(1);
		expect(conversation).toMatchObject({ id: 1, name: "Chat", revision: 1 });
		expect(story.messages).toEqual([]);
	});

	test("a rejected fetch stays an offline NetworkError", async () => {
		const refresh = historyRefresh(async () => { throw new TypeError("fetch failed"); });
		await expect(refresh).rejects.toBeInstanceOf(NetworkError);
	});

	test("an unusable history response throws a plain Error", async () => {
		const refresh = historyRefresh(async () => Response.json({ error: "Server bug" }, { status: 500 }));
		await expect(refresh).rejects.toBeInstanceOf(Error);
		await expect(refresh).rejects.not.toBeInstanceOf(NetworkError);
	});
});
