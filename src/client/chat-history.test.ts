import { describe, expect, test } from "bun:test";
import { createChatHistoryTransport } from "./chat-history";

// The history wire boundary validates every page against the canonical
// shared contract before the view may trust it. The server-derived
// capability objects (Continue and targeted Swipe eligibility) are required
// fields, so a payload without them can never masquerade as trusted
// history: the server always emits them and the client never reconstructs
// them from optional hints.

const messagePayload = {
	id: 10,
	position: 1,
	timestamp: "2026-01-01T00:00:00.000Z",
	modelParticipantIdAtCreation: 20,
	continuable: true,
	swipe: { eligible: true, reason: null },
	author: { participantId: 20, capturedName: "Model", inCast: true },
	variants: [
		{ id: 100, position: 1, content: "Once", timestamp: "2026-01-01T00:00:00.000Z", selected: true },
	],
};

const jsonPage = (messages: readonly object[]): Response =>
	new Response(
		JSON.stringify({
			conversationId: 7,
			name: "Lantern House",
			revision: 3,
			cast: [{ id: 1, position: 1, name: "Writer" }],
			page: {
				index: 1,
				pageSize: 2,
				totalMessages: 1,
				totalPages: 1,
				hasOlder: false,
				hasNewer: false,
			},
			messages,
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);

const loadFirstPage = (fetchImpl: (input: RequestInfo | URL) => Promise<Response>) =>
	createChatHistoryTransport({ fetchImpl }).loadHistory(7, { page: 1 });

describe("history transport boundary validation", () => {
	test("distinguishes a temporary transport outage from a permanent HTTP failure", async () => {
		expect(await loadFirstPage(async () => { throw new TypeError("Failed to fetch"); })).toEqual({ status: "network" });
		expect(await loadFirstPage(async () => Response.json({ error: "Unavailable" }, { status: 503 }))).toEqual({ status: "invalid" });
	});

	test("passes cancellation to the history request", async () => {
		const controller = new AbortController();
		let signal: AbortSignal | null | undefined;
		await createChatHistoryTransport({ fetchImpl: async (_input, init) => {
			signal = init?.signal;
			return jsonPage([messagePayload]);
		} }).loadHistory(7, { page: 1 }, controller.signal);
		expect(signal).toBe(controller.signal);
	});

	test("accepts a page carrying the required server-derived capability objects", async () => {
		const outcome = await loadFirstPage(async () => jsonPage([messagePayload]));
		expect(outcome.status).toBe("available");
		if (outcome.status === "available") {
			expect(outcome.page.messages[0]?.swipe).toEqual({
				eligible: true,
				reason: null,
			});
			expect(outcome.page.messages[0]?.continuable).toBe(true);
		}
	});

	test("rejects a page whose Swipe eligibility fabricates an impossible state", async () => {
		const outcome = await loadFirstPage(async () =>
			jsonPage([
				{
					...messagePayload,
					swipe: { eligible: true, reason: "missing-historical-context" },
				},
			]));
		expect(outcome.status).toBe("invalid");
	});
});
