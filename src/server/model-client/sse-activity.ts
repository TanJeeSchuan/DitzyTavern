import { createParser } from "eventsource-parser";
// ==[HUMAN APPROVED]== The AI SDK surfaces only parsed deltas, but the Connection Profile's Stream
// Inactivity Timeout is quiet-byte semantics: keep-alive pings prove liveness
// while no token is ready. Raw byte visibility is available only by wrapping
// the response body at the fetch boundary, so this module keeps a deliberately
// observer for activity detection only.

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
