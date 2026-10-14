import { createParser } from "eventsource-parser";
import { Value } from "@sinclair/typebox/value";
import { providerActivityFrame } from "../../shared/contract/provider-sse";
// @approved
//  The AI SDK surfaces parsed deltas. Observe SSE comments and meaningful
// events at the fetch boundary so keep-alive pings reset the Stream Inactivity Timeout.

export interface SseActivityMonitorOptions {
	readonly onActivity: () => void;
	readonly signal: AbortSignal;
}

export function monitorSseActivity(
	response: Response,
	options: SseActivityMonitorOptions,
): Response {
	if (response.body === null) return response;
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const parser = createParser({
		onComment: options.onActivity,
		onEvent: ({ data }) => {
			if (data === "[DONE]") { options.onActivity(); return; }
			try {
				if (Value.Check(providerActivityFrame, JSON.parse(data))) options.onActivity();
			} catch { /* @approved The AI SDK owns malformed provider payloads. */ }
		},
	});
	const cancelReader = () => {
		void reader.cancel();
	};
	if (options.signal.aborted) cancelReader();
	else options.signal.addEventListener("abort", cancelReader, { once: true });
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await reader.read();
				if (next.done) {
					options.signal.removeEventListener("abort", cancelReader);
					controller.close();
					return;
				}
				parser.feed(decoder.decode(next.value, { stream: true }));
				controller.enqueue(next.value);
			} catch (error) {
				controller.error(error);
				return;
			}
		},
		cancel(reason) {
			options.signal.removeEventListener("abort", cancelReader);
			return reader.cancel(reason);
		},
	});
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
