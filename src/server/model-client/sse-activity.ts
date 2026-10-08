import { createParser } from "eventsource-parser";
// @approved
//  The AI SDK surfaces parsed deltas. Observe SSE comments and meaningful
// events at the fetch boundary so keep-alive pings reset the Stream Inactivity Timeout.

interface ProviderSseFrame {
	choices?: Array<{
		delta?: {
			content?: string;
			reasoning?: string;
			reasoning_content?: string;
			reasoning_details?: unknown;
		};
		finish_reason?: string | null;
	}>;
	usage?: unknown;
}

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
				// SAFETY: only optional activity fields are inspected; malformed payloads are caught below.
				const parsed = JSON.parse(data) as ProviderSseFrame;
				const choice = parsed.choices?.[0];
				const delta = choice?.delta;
				if (delta?.content !== undefined || delta?.reasoning !== undefined ||
					delta?.reasoning_content !== undefined || delta?.reasoning_details !== undefined ||
					parsed.usage !== undefined || choice?.finish_reason != null) options.onActivity();
			} catch { /* The AI SDK owns malformed provider payloads. */ }
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
