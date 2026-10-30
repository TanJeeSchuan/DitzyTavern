import type { Context, SSEPayload } from "elysia";

export function subscriptionEvents(
	{ request, set }: Pick<Context, "request" | "set">,
	subscribe: (emit: (event: SSEPayload | Uint8Array) => void, close: () => void) => () => void,
	{ latest = false } = {},
) {
	Object.assign(set.headers, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
	const events: (SSEPayload | Uint8Array)[] = [];
	let ready = Promise.withResolvers<void>();
	let closed = false;
	let unsubscribe: (() => void) | undefined;
	const close = () => {
		if (closed) return;
		closed = true;
		unsubscribe?.();
		request.signal.removeEventListener("abort", close);
		ready.resolve();
	};
	// @approved
	//  A stream of latest states keeps only the newest event a slow reader has
	// not taken yet; its keep-alive bytes stay queued.
	unsubscribe = subscribe((event) => {
		if (closed) return;
		if (latest && !(event instanceof Uint8Array)) events.splice(0, events.length, ...events.filter((queued) => queued instanceof Uint8Array));
		events.push(event);
		ready.resolve();
	}, close);
	if (closed) unsubscribe();
	else if (request.signal.aborted) close();
	else request.signal.addEventListener("abort", close, { once: true });
	if (!closed && events.length === 0) events.push(new Uint8Array());
	return new class {
		[Symbol.asyncIterator]() { return this; }
		async next(): Promise<IteratorResult<SSEPayload | Uint8Array>> {
			while (events.length === 0 && !closed) { await ready.promise; ready = Promise.withResolvers<void>(); }
			const value = events.shift();
			return value === undefined ? { done: true, value } : { done: false, value };
		}
		async return(): Promise<IteratorResult<SSEPayload | Uint8Array>> { close(); return { done: true, value: undefined }; }
	}();
}
