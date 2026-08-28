import { afterEach, describe, expect, test } from "bun:test";
import type { GenerationStreamDelta } from "./conversation-stream";

const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, "window", {
	configurable: true,
	// SAFETY: the test supplies the minimal browser location read by Eden.
	value: { location: { origin: "http://localhost" } } as Window,
});
const {
	startConversationGeneration,
	startConversationSiblingGeneration,
	startConversationContinuationGeneration,
	stopConversationGeneration,
	stopAllConversationGenerations,
} = await import("./conversation");
const { subscribeConversationGeneration } = await import("./conversation-stream");

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const installFetch = (handler: FetchHandler): void => {
	globalThis.fetch = Object.assign(handler, { preconnect: () => {} });
};

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("server-owned Generation client", () => {
	test("subscribes to the final events route, decodes split SSE frames, and returns completion", async () => {
		const encoder = new TextEncoder();
		const chunks = [
			"id: 1\nevent: generation\ndata: {\"type\":\"content\",\"text\":\"Hel",
			"lo\"}\n\nevent: generation\ndata: {\"type\":\"reasoning\",\"text\":\"plan\"}\n\n",
			"id: 2\nevent: generation\ndata: {\"type\":\"finished\",\"finishReason\":\"stop\"}\n\n",
			"event: complete\ndata: {\"outcome\":\"applied\"}\n\n",
		];
		let requestUrl = "";
		installFetch(async (input) => {
			requestUrl = String(input);
			return new Response(new ReadableStream({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
					controller.close();
				},
			}), { status: 200, headers: { "content-type": "text/event-stream" } });
		});

		const deltas: GenerationStreamDelta[] = [];
		const result = await subscribeConversationGeneration(42, 7, {
			onDelta: (delta) => deltas.push(delta),
		});

		expect(requestUrl).toBe("/api/conversations/42/generations/7/events");
		expect(deltas).toEqual([
			{ type: "content", text: "Hello" },
			{ type: "reasoning", text: "plan" },
			{ type: "finished", finishReason: "stop" },
		]);
		expect(result).toEqual({ outcome: "applied" });
	});

	test("does not turn malformed or non-terminal frames into visible Generation state", async () => {
		installFetch(async () => new Response(
			"event: generation\ndata: {not-json}\n\nevent: message\ndata: {}\n\n",
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		));

		const deltas: GenerationStreamDelta[] = [];
		const result = await subscribeConversationGeneration(42, 7, { onDelta: (delta) => deltas.push(delta) });
		expect(deltas).toEqual([]);
		expect(result).toEqual({ outcome: "failed", reason: "Generation ended without a terminal result." });
	});

	test("starts acceptance through JSON and leaves event observation to a separate request", async () => {
		let requestUrl = "";
		let requestBody = "";
		installFetch(async (input, init) => {
			requestUrl = String(input);
			requestBody = String(init?.body);
			return new Response(JSON.stringify({
				outcome: "accepted",
				generationId: 7,
				conversationId: 42,
				messageId: 9,
				variantId: 10,
			}), { status: 200, headers: { "content-type": "application/json" } });
		});

		const result = await startConversationGeneration(42, 3, "Keep going.");
		expect(requestUrl).toBe("http://localhost/api/conversations/42/generations");
		expect(requestBody).toBe(JSON.stringify({ expectedRevision: 3, content: "Keep going." }));
		expect(result).toEqual({
			outcome: "accepted",
			generationId: 7,
			conversationId: 42,
			messageId: 9,
			variantId: 10,
		});
	});

	test("ignores duplicated and out-of-order numbered Generation frames", async () => {
		installFetch(async () => new Response(
			"id: 2\nevent: generation\ndata: {\"type\":\"content\",\"text\":\"B\"}\n\n" +
			"id: 1\nevent: generation\ndata: {\"type\":\"content\",\"text\":\"A\"}\n\n" +
			"id: 2\nevent: generation\ndata: {\"type\":\"content\",\"text\":\"duplicate\"}\n\n" +
			"id: 3\nevent: generation\ndata: {\"type\":\"finished\",\"finishReason\":\"stop\"}\n\n" +
			"event: complete\ndata: {\"outcome\":\"applied\"}\n\n",
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		));

		const deltas: GenerationStreamDelta[] = [];
		const result = await subscribeConversationGeneration(42, 7, { onDelta: (delta) => deltas.push(delta) });
		expect(deltas).toEqual([
			{ type: "content", text: "B" },
			{ type: "finished", finishReason: "stop" },
		]);
		expect(result).toEqual({ outcome: "applied" });
	});

	test("uses the typed JSON routes for each generation start and stop command", async () => {
		const requestUrls: string[] = [];
		installFetch(async (input) => {
			requestUrls.push(String(input));
			const url = String(input);
			if (url.endsWith("/stop") || url.endsWith("/stop-all")) {
				return Response.json({ outcome: "stopped", generationId: 7, generationIds: [7] });
			}
			return Response.json({
				outcome: "accepted",
				generationId: 7,
				conversationId: 42,
				messageId: 9,
				variantId: 10,
			});
		});

		await startConversationGeneration(42, 3, "Keep going.");
		await startConversationSiblingGeneration(42, 9);
		await startConversationContinuationGeneration(42, 3);
		await stopConversationGeneration(42, 7);
		await stopAllConversationGenerations(42);

		expect(requestUrls).toEqual([
			"http://localhost/api/conversations/42/generations",
			"http://localhost/api/conversations/42/messages/9/sibling/generations",
			"http://localhost/api/conversations/42/continue/generations",
			"http://localhost/api/conversations/42/generations/7/stop",
			"http://localhost/api/conversations/42/generations/stop-all",
		]);
	});
});
