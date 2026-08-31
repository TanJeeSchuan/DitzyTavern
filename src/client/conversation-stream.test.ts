import { afterEach, describe, expect, test } from "bun:test";
import type { GenerationStreamDelta, GenerationStreamState } from "./conversation-stream";

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
const { generationStreamAdapter, subscribeConversationGeneration } = await import("./conversation-stream");

const attemptTarget = {
	conversationId: 42,
	generationId: 7,
	messageId: 9,
	variantId: 10,
} as const;

const terminalPayload = <Payload extends object>(payload: Payload): string =>
	JSON.stringify({ ...attemptTarget, ...payload });

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
			"lo\"}\n\nid: 2\nevent: generation\ndata: {\"type\":\"reasoning\",\"text\":\"plan\"}\n\n",
			"id: 3\nevent: generation\ndata: {\"type\":\"finished\",\"finishReason\":\"stop\"}\n\n",
			`event: complete\ndata: ${terminalPayload({ outcome: "applied", latestEventId: 3 })}\n\n`,
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
			messageId: 9,
			variantId: 10,
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
		const result = await subscribeConversationGeneration(42, 7, {
			messageId: 9,
			variantId: 10,
			onDelta: (delta) => deltas.push(delta),
		});
		expect(deltas).toEqual([]);
		expect(result).toEqual({ outcome: "interrupted", reason: "Generation ended without a terminal result." });
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
			`event: complete\ndata: ${terminalPayload({ outcome: "applied", latestEventId: 3 })}\n\n`,
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		));

		const deltas: GenerationStreamDelta[] = [];
		const result = await subscribeConversationGeneration(42, 7, {
			messageId: 9,
			variantId: 10,
			onDelta: (delta) => deltas.push(delta),
		});
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

	describe("the session stream interface", () => {
		test("the production adapter resumes from the requested position and reports event positions", async () => {
			let requestUrl = "";
			const stream =
				"id: 4\nevent: generation\ndata: {\"type\":\"content\",\"text\":\"Resumed.\"}\n\n" +
				"event: state\ndata: {\"outcome\":\"active-state\",\"generationId\":7,\"conversationId\":42,\"messageId\":9,\"variantId\":10,\"content\":\"Resumed.\",\"reasoning\":\"\",\"latestEventId\":5,\"status\":\"active\",\"terminalReason\":null}\n\n" +
				`event: complete\ndata: ${terminalPayload({ outcome: "applied", latestEventId: 5 })}\n\n`;
			installFetch(async (input) => {
				requestUrl = String(input);
				return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
			});

			const observations: { eventId: number; text: string }[] = [];
			const states: number[] = [];
			const result = await generationStreamAdapter.subscribe({
				conversationId: 42,
				generationId: 7,
				messageId: 9,
				variantId: 10,
				afterEventId: 3,
				signal: new AbortController().signal,
				onEvent: ({ eventId, event }) => {
					if (event.type === "content") observations.push({ eventId, text: event.text });
				},
				onState: (state) => states.push(state.latestEventId),
			});

			expect(requestUrl).toBe("/api/conversations/42/generations/7/events?after=3");
			expect(observations).toEqual([{ eventId: 4, text: "Resumed." }]);
			expect(states).toEqual([5]);
			expect(result).toEqual({ outcome: "applied" });
		});

		test("generation frames without a stream position never reach the session observer", async () => {
			installFetch(async () => new Response(
				"event: generation\ndata: {\"type\":\"content\",\"text\":\"Unpositioned.\"}\n\n" +
				"id: 1\nevent: generation\ndata: {\"type\":\"content\",\"text\":\"Positioned.\"}\n\n",
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			));

			const observations: number[] = [];
			const result = await generationStreamAdapter.subscribe({
				conversationId: 42,
				generationId: 7,
				messageId: 9,
				variantId: 10,
				afterEventId: 0,
				signal: new AbortController().signal,
				onEvent: ({ eventId }) => observations.push(eventId),
				onState: () => {},
			});

			expect(observations).toEqual([1]);
			expect(result).toEqual({ outcome: "interrupted", reason: "Generation ended without a terminal result." });
		});

		test("a typed error status response is a server-declared outcome; an opaque one is an interruption", async () => {
			installFetch(async () => new Response(
				JSON.stringify({ outcome: "not-found" }),
				{ status: 404, headers: { "content-type": "application/json" } },
			));
			const missing = await generationStreamAdapter.subscribe({
				conversationId: 42,
				generationId: 7,
				messageId: 9,
				variantId: 10,
				afterEventId: 0,
				signal: new AbortController().signal,
				onEvent: () => {},
				onState: () => {},
			});
			expect(missing).toEqual({ outcome: "not-found" });

			installFetch(async () => new Response("server exploded", { status: 500 }));
			const unreachable = await generationStreamAdapter.subscribe({
				conversationId: 42,
				generationId: 7,
				messageId: 9,
				variantId: 10,
				afterEventId: 0,
				signal: new AbortController().signal,
				onEvent: () => {},
				onState: () => {},
			});
			expect(unreachable).toEqual({ outcome: "interrupted", reason: "Generation subscription could not be opened." });
		});
	});

	describe("shared schema decoding at the stream seam", () => {
		test("decodes every normalized Generation event kind before the callback sees it", async () => {
			const frames: GenerationStreamDelta[] = [
				{ type: "content", text: "Hello" },
				{ type: "reasoning", text: "Thinking." },
				{ type: "usage", usage: { inputTokens: 4, totalTokens: 4 } },
				{ type: "keepalive" },
				{ type: "finished", finishReason: "length" },
				{ type: "failed", kind: "inactivity", message: "The provider went quiet." },
			];
			const stream = frames
				.map((frame, index) => `id: ${index + 1}\nevent: generation\ndata: ${JSON.stringify(frame)}\n\n`)
				.join("") +
				`event: error\ndata: ${terminalPayload({ outcome: "failed", reason: "The provider went quiet." })}\n\n`;
			installFetch(async () => new Response(stream, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}));

			const deltas: GenerationStreamDelta[] = [];
			const result = await subscribeConversationGeneration(42, 7, {
				messageId: 9,
				variantId: 10,
				onDelta: (delta) => deltas.push(delta),
			});

			expect(deltas).toEqual(frames);
			expect(result).toEqual({ outcome: "failed", reason: "The provider went quiet." });
		});

		test("drops generation frames that fail the shared event schema", async () => {
			const stream = [
				"event: generation\ndata: {\"type\":\"content\"}\n\n",
				"event: generation\ndata: {\"type\":\"usage\",\"usage\":{\"inputTokens\":\"4\"}}\n\n",
				"event: generation\ndata: {\"type\":\"finished\",\"finishReason\":\"STOP\"}\n\n",
				"event: generation\ndata: {\"type\":\"failed\",\"kind\":\"mystery\",\"message\":\"x\"}\n\n",
				"id: 5\nevent: generation\ndata: {\"type\":\"content\",\"text\":\"Valid.\"}\n\n",
			].join("");
			installFetch(async () => new Response(stream, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}));

			const deltas: GenerationStreamDelta[] = [];
			const result = await subscribeConversationGeneration(42, 7, {
				messageId: 9,
				variantId: 10,
				onDelta: (delta) => deltas.push(delta),
			});

			expect(deltas).toEqual([{ type: "content", text: "Valid." }]);
			expect(result).toEqual({ outcome: "interrupted", reason: "Generation ended without a terminal result." });
		});

		test("decodes the authoritative state snapshot through the shared schema", async () => {
			const state: GenerationStreamState = {
				outcome: "active-state",
				generationId: 7,
				conversationId: 42,
				messageId: 9,
				variantId: 10,
				content: "Checkpointed.",
				reasoning: "",
				latestEventId: 4,
				status: "active",
				terminalReason: null,
			};
			const stream =
				"event: state\ndata: " + JSON.stringify(state) + "\n\n" +
				"event: state\ndata: {\"outcome\":\"active-state\",\"generationId\":\"7\"}\n\n";
			installFetch(async () => new Response(stream, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}));

			const states: GenerationStreamState[] = [];
			const result = await subscribeConversationGeneration(42, 7, {
				messageId: 9,
				variantId: 10,
				onDelta: () => {},
				onState: (decoded) => states.push(decoded),
			});

			expect(states).toEqual([state]);
			expect(result).toEqual({ outcome: "interrupted", reason: "Generation ended without a terminal result." });
		});

		test("rejects state and terminal frames for a different attempt target", async () => {
			const foreignState: GenerationStreamState = {
				outcome: "active-state",
				generationId: 8,
				conversationId: 42,
				messageId: 9,
				variantId: 10,
				content: "Wrong attempt.",
				reasoning: "Wrong reasoning.",
				latestEventId: 4,
				status: "active",
				terminalReason: null,
			};
			const foreignFrames = [
				`event: state\ndata: ${JSON.stringify(foreignState)}\n\n`,
				"event: complete\ndata: {\"outcome\":\"applied\",\"conversationId\":42,\"generationId\":7,\"messageId\":99,\"variantId\":10,\"latestEventId\":4}\n\n",
				"event: stopped\ndata: {\"outcome\":\"stopped\",\"conversationId\":42,\"generationId\":7,\"messageId\":9,\"variantId\":99}\n\n",
				"event: error\ndata: {\"outcome\":\"failed\",\"reason\":\"Wrong attempt.\",\"conversationId\":42,\"generationId\":8,\"messageId\":9,\"variantId\":10}\n\n",
			];
			for (const stream of foreignFrames) {
				installFetch(async () => new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}));

				const states: GenerationStreamState[] = [];
				const result = await subscribeConversationGeneration(42, 7, {
					messageId: 9,
					variantId: 10,
					onDelta: () => {},
					onState: (state) => states.push(state),
				});

				expect(states).toEqual([]);
				expect(result).toEqual({
					outcome: "interrupted",
					reason: "Generation ended without a terminal result.",
				});
			}
		});

		test("decodes stopped and failure terminal frames through the shared schemas", async () => {
			installFetch(async () => new Response(
				`event: stopped\ndata: ${terminalPayload({ outcome: "stopped" })}\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			));
			const stopped = await subscribeConversationGeneration(42, 7, {
				messageId: 9,
				variantId: 10,
				onDelta: () => {},
			});
			expect(stopped).toEqual({ outcome: "stopped", generationId: 7 });

			installFetch(async () => new Response(
				`event: error\ndata: ${terminalPayload({ outcome: "not-found" })}\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			));
			const notFound = await subscribeConversationGeneration(42, 7, {
				messageId: 9,
				variantId: 10,
				onDelta: () => {},
			});
			expect(notFound).toEqual({ outcome: "not-found" });

			installFetch(async () => new Response(
				"event: error\ndata: {\"outcome\":\"expired\"}\n\n",
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			));
			const unknownOutcome = await subscribeConversationGeneration(42, 7, {
				messageId: 9,
				variantId: 10,
				onDelta: () => {},
			});
			expect(unknownOutcome).toEqual({ outcome: "interrupted", reason: "Generation ended without a terminal result." });
		});
	});
});
