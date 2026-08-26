import { afterEach, describe, expect, test } from "bun:test";
import type { GenerationStreamDelta } from "./conversation";

const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, "window", {
	configurable: true,
	// SAFETY: the Eden client only reads window.location.origin during module
	// initialization; the test supplies that minimal browser boundary.
	value: { location: { origin: "http://localhost" } } as Window,
});
const { streamConversationReply } = await import("./conversation");

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const installFetch = (handler: FetchHandler): void => {
	globalThis.fetch = Object.assign(handler, { preconnect: () => {} });
};

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("Conversation generation stream client", () => {
	test("decodes split SSE frames, forwards normalized deltas, and returns completion", async () => {
		const encoder = new TextEncoder();
		const chunks = [
			"event: generation\ndata: {\"type\":\"content\",\"text\":\"Hel",
			"lo\"}\n\nevent: generation\ndata: {\"type\":\"reasoning\",\"text\":\"plan\"}\n\n",
			"event: generation\ndata: {\"type\":\"finished\",\"finishReason\":\"stop\"}\n\n",
			"event: complete\ndata: {\"outcome\":\"applied\"}\n\n",
		];
		installFetch(async () => new Response(new ReadableStream({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		}), { status: 200, headers: { "content-type": "text/event-stream" } }));

		const deltas: GenerationStreamDelta[] = [];
		const result = await streamConversationReply(42, {
			onDelta: (delta) => deltas.push(delta),
		});

		expect(deltas).toEqual([
			{ type: "content", text: "Hello" },
			{ type: "reasoning", text: "plan" },
			{ type: "finished", finishReason: "stop" },
		]);
		expect(result).toMatchObject({ outcome: "applied" });
	});

	test("does not turn malformed or non-terminal frames into visible generation state", async () => {
		installFetch(async () => new Response(
			"event: generation\ndata: {not-json}\n\nevent: message\ndata: {}\n\n",
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		));

		const deltas: GenerationStreamDelta[] = [];
		const result = await streamConversationReply(42, { onDelta: (delta) => deltas.push(delta) });

		expect(deltas).toEqual([]);
		expect(result).toEqual({ outcome: "failed", reason: "Generation ended without a terminal result." });
	});

	test("rejects terminal failures without their required reason", async () => {
		installFetch(async () => new Response(
			"event: error\ndata: {\"outcome\":\"failed\"}\n\n",
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		));

		const result = await streamConversationReply(42, { onDelta: () => {} });

		expect(result).toEqual({ outcome: "failed", reason: "Generation ended without a terminal result." });
	});
});
