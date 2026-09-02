// ==[HUMAN APPROVED]== The AI SDK surfaces only parsed deltas, but the Connection Profile's Stream
// Inactivity Timeout is quiet-byte semantics: keep-alive pings prove liveness
// while no token is ready. Raw byte visibility is available only by wrapping
// the response body at the fetch boundary, so this module keeps a deliberately
// small second SSE parser for activity detection only.

export interface ProviderSseFrame {
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
	let pending = "";
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
				pending += decoder.decode(next.value, { stream: true });
				const frames = pending.split(/\r?\n\r?\n/);
				pending = frames.pop() ?? "";
				for (const frame of frames) {
					// ==[HUMAN APPROVED]== SSE comment frames (for example provider keep-alive pings)
					// are deliberate provider activity: they prove the connection is
					// delivering bytes while no token is ready, so they reset the
					// inactivity timer. Only true silence may abort the stream.
					if (frame.split(/\r?\n/).some((line) => line.trimStart().startsWith(":"))) {
						options.onActivity();
						continue;
					}
					const data = frame
						.split(/\r?\n/)
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).trimStart())
						.join("\n");
					if (data === "[DONE]") {
						options.onActivity();
						continue;
					}
					try {
						// ==[HUMAN APPROVED]== SAFETY: this is the validated JSON object boundary for SSE activity
						// inspection; AI SDK remains authoritative for actual response parsing.
						const parsed = JSON.parse(data) as ProviderSseFrame;
						const choice = parsed.choices?.[0];
						const delta = choice?.delta;
						if (
							delta?.content !== undefined ||
							delta?.reasoning !== undefined ||
							delta?.reasoning_content !== undefined ||
							delta?.reasoning_details !== undefined ||
							parsed.usage !== undefined ||
							choice?.finish_reason !== null && choice?.finish_reason !== undefined
						) {
							options.onActivity();
						}
					} catch {
						// ==[HUMAN APPROVED]== AI SDK owns malformed-frame handling. Arbitrary or incomplete
						// bytes are deliberately not considered stream activity here.
					}
				}
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
