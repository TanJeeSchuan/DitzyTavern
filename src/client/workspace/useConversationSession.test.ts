import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NetworkError } from "../lib/request-outcome";
import { createStoryState, type StoryAction } from "../story";
import type { ChatHistoryPage } from "../chat-history";
import type { ConversationSummary } from "../conversation";
import { adoptConversationSummary } from "./conversation-session-state";

const summary = (id: number, revision: number) => {
	// SAFETY: The pure adoption helper reads only id and revision; the fixture deliberately supplies that tested boundary.
	return { id, revision } as ConversationSummary;
};

describe("adoptConversationSummary", () => {
	test("rejects snapshots for another chat", () => {
		const current = summary(1, 4);

		expect(adoptConversationSummary(current, summary(2, 99), 1)).toBe(current);
	});

	test("rejects older snapshots for the active chat", () => {
		const current = summary(1, 4);

		expect(adoptConversationSummary(current, summary(1, 3), 1)).toBe(current);
	});

	test("adopts a newer snapshot for the active chat", () => {
		const incoming = summary(1, 5);

		expect(adoptConversationSummary(summary(1, 4), incoming, 1)).toBe(incoming);
	});
});

const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, "window", {
	configurable: true,
	// SAFETY: the test supplies the minimal browser location read by Eden.
	value: { location: { origin: "http://localhost" } } as Window,
});
const { useConversationSession } = await import("./useConversationSession");

afterEach(() => {
	globalThis.fetch = originalFetch;
});

async function historyRefresh(historyResponse: () => Promise<Response>) {
	const conversation: ConversationSummary = {
		id: 1, name: "Chat", revision: 1, authorNote: "", cast: [],
		control: { humanParticipantId: null, modelParticipantId: null },
		controlValidity: { valid: false, reason: "missing-seat" },
		playable: false,
		capabilities: {
			compose: { available: false, reason: "conversation-not-playable" },
			generate: { available: false, reason: "conversation-not-playable" },
			swipe: { available: false, reason: "conversation-not-playable" },
		},
		activeGenerations: [],
	};
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL) =>
		String(input).includes("/history") ? historyResponse() : Response.json(conversation),
	{ preconnect: () => {} });
	let session: ReturnType<typeof useConversationSession> | undefined;
	const dispatched: StoryAction[] = [];
	const activeChat = { id: "1", title: "Chat", updatedAt: "", cast: [], excerpt: "" };
	renderToStaticMarkup(createElement(() => {
		session = useConversationSession({
			initialWorkspace: { activeChat, chats: [activeChat], characters: [] },
			story: { ...createStoryState(), conversationId: 1 },
			dispatchStory: (action) => { dispatched.push(action); },
		});
		return null;
	}));
	if (!session) throw new Error("The session hook did not render.");
	const loaded = await session.refreshStory(1);
	return { conversation: loaded, dispatched };
}

describe("history refresh error classification", () => {
	test("a valid history page refreshes the Conversation", async () => {
		const page: ChatHistoryPage = {
			conversationId: 1, name: "Chat", revision: 1, cast: [],
			messages: [{
				id: 11, position: 1, timestamp: "2026-01-01T00:00:00.000Z",
				modelParticipantIdAtCreation: null, continuable: false,
				swipe: { eligible: false, reason: "conversation-not-playable" },
				author: null, variants: [],
			}],
			page: { index: 1, pageSize: 10, totalMessages: 1, totalPages: 1, hasOlder: false, hasNewer: false },
		};
		const { conversation, dispatched } = await historyRefresh(async () => Response.json(page));
		expect(conversation?.id).toBe(1);
		// The refresh must APPLY the returned history, not merely resolve.
		expect(dispatched).toContainEqual({
			type: "first-page",
			page,
			activeGenerationIds: [],
		});
	});

	test("a missing history page keeps the existing not-found behavior", async () => {
		const { conversation, dispatched } = await historyRefresh(async () => Response.json({ outcome: "not-found" }, { status: 404 }));
		expect(conversation?.id).toBe(1);
		// The existing not-found behavior: a missing page is skipped, not
		// treated as a failure — neither page application nor failure dispatch.
		expect(dispatched.some(({ type }) => type === "first-page")).toBe(false);
		expect(dispatched.some(({ type }) => type === "history-failed")).toBe(false);
	});

	test("a rejected fetch stays an offline NetworkError", async () => {
		const refresh = historyRefresh(async () => { throw new TypeError("fetch failed"); });
		await expect(refresh).rejects.toBeInstanceOf(NetworkError);
	});

	test.each([
		["server 500", () => Response.json({ error: "Server bug" }, { status: 500 })],
		["malformed 404", () => Response.json({ error: "Unknown response" }, { status: 404 })],
		["invalid response", () => Response.json({ outcome: "invalid", reason: "Invalid history" }, { status: 422 })],
		["malformed history page", () => Response.json({ messages: [] })],
		["invalid JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
	])("%s throws a plain Error", async (_name, response) => {
		const refresh = historyRefresh(async () => response());
		await expect(refresh).rejects.toBeInstanceOf(Error);
		await expect(refresh).rejects.not.toBeInstanceOf(NetworkError);
	});
});
