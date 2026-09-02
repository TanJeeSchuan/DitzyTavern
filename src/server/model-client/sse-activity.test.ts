import { describe, expect, test } from "bun:test";
import { monitorSseActivity } from "./sse-activity";

const encoder = new TextEncoder();

function responseFromChunks(chunks: readonly string[]): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		}),
		{
			status: 207,
			statusText: "Multi-Status",
			headers: { "content-type": "text/event-stream", "x-test": "preserved" },
		},
	);
}

describe("SSE activity monitor", () => {
	test("passes through bytes and treats comment pings and terminal frames as activity", async () => {
		let activityCount = 0;
		const signal = new AbortController().signal;
		const source = [
			": keep-alive\r\n",
			"\r\n",
			`data: ${JSON.stringify({
				choices: [{ delta: { content: "Visible" }, finish_reason: null }],
			})}\r\n\r\n`,
			"data: [DONE]\r\n\r\n",
		];
		const monitored = monitorSseActivity(responseFromChunks(source), {
			onActivity: () => {
				activityCount += 1;
			},
			signal,
		});

		expect(monitored.status).toBe(207);
		expect(monitored.statusText).toBe("Multi-Status");
		expect(monitored.headers.get("x-test")).toBe("preserved");
		expect(await monitored.text()).toBe(source.join(""));
		expect(activityCount).toBe(3);
	});

	test("buffers CRLF-delimited frames and ignores malformed or empty data", async () => {
		let activityCount = 0;
		const signal = new AbortController().signal;
		const source = [
			"data: {not-json}\r\n",
			"\r\n",
			`data: ${JSON.stringify({
				choices: [{ delta: { reasoning_content: "Thinking" }, finish_reason: null }],
			})}\r\n\r\n`,
			`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: null }] })}\r\n\r\n`,
			"event: ping\r\ndata:\r\n\r\n",
		];
		const monitored = monitorSseActivity(responseFromChunks(source), {
			onActivity: () => {
				activityCount += 1;
			},
			signal,
		});

		expect(await monitored.text()).toBe(source.join(""));
		expect(activityCount).toBe(1);
	});

	test("cancels the underlying reader when the signal aborts", async () => {
		let cancelled = false;
		let resolveCancelled: (() => void) | undefined;
		const cancelledPromise = new Promise<void>((resolve) => {
			resolveCancelled = resolve;
		});
		const source = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
				resolveCancelled?.();
			},
		});
		const controller = new AbortController();
		monitorSseActivity(new Response(source), {
			onActivity: () => {},
			signal: controller.signal,
		});

		controller.abort();
		await cancelledPromise;
		expect(cancelled).toBe(true);
	});
});
