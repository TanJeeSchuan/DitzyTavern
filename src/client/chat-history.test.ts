import { afterEach, describe, expect, test } from "bun:test";
import type { WirePayload } from "./lib/wire-decode";

// The history wire boundary validates every page against the canonical
// shared contract before the view may trust it. The server-derived
// capability objects (Continue and targeted Swipe eligibility) are required
// fields, so a payload without them can never masquerade as trusted
// history: the server always emits them and the client never reconstructs
// them from optional hints.

Object.defineProperty(globalThis, "window", {
	configurable: true,
	// SAFETY: the test supplies the minimal browser location read by Eden.
	value: { location: { origin: "http://localhost" } } as Window,
});
const originalFetch = globalThis.fetch;
const { loadHistoryPage } = await import("./chat-history");
const { SERVER_UNUSABLE_RESPONSE_NOTICE } = await import("./lib/request-outcome");

const installFetch = (handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void => {
	globalThis.fetch = Object.assign(handler, { preconnect: () => {} });
};

const json = (payload: WirePayload, status: number): Response =>
	new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});

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

const loadFirstPage = () => loadHistoryPage(7, { page: 1 });

describe("history transport boundary validation", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("an unmodeled read outcome is the shared invalid fallback, never a transport failure", async () => {
		installFetch(async () => json({ error: "Unavailable" }, 503));
		expect(await loadFirstPage()).toEqual({ outcome: "invalid", reason: SERVER_UNUSABLE_RESPONSE_NOTICE });
	});

	test("passes cancellation to the history request", async () => {
		const controller = new AbortController();
		let signal: AbortSignal | null | undefined;
		installFetch(async (_input, init) => {
			signal = init?.signal;
			return jsonPage([messagePayload]);
		});
		await loadHistoryPage(7, { page: 1 }, controller.signal);
		expect(signal).toBe(controller.signal);
	});

	test("trusts a contract-valid page and normalizes a fabricated Swipe state to the invalid fallback", async () => {
		installFetch(async () => jsonPage([messagePayload]));
		const outcome = await loadFirstPage();
		expect(outcome.outcome).toBe("available");
		if (outcome.outcome === "available") {
			expect(outcome.value.messages[0]?.swipe).toEqual({
				eligible: true,
				reason: null,
			});
			expect(outcome.value.messages[0]?.continuable).toBe(true);
		}

		installFetch(async () =>
			jsonPage([
				{
					...messagePayload,
					swipe: { eligible: true, reason: "missing-historical-context" },
				},
			]));
		expect(await loadFirstPage()).toEqual({ outcome: "invalid", reason: SERVER_UNUSABLE_RESPONSE_NOTICE });
	});
});
