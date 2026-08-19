export type ResumableSSEEvent = {
	id: string;
	type: string;
	data: string;
};

export type SSEHandlers = {
	onEvent?: (event: ResumableSSEEvent) => void;
	onError?: (event: Event) => void;
};

export function subscribeToEvents(
	url: string,
	lastEventId: string | null,
	handlers: SSEHandlers,
): () => void {
	const target = lastEventId
		? `${url}${url.includes("?") ? "&" : "?"}lastEventId=${encodeURIComponent(lastEventId)}`
		: url;

	const source = new EventSource(target);

	source.onmessage = (message) => {
		handlers.onEvent?.({
			id: message.lastEventId ?? "",
			type: message.type,
			data: message.data,
		});
	};

	source.onerror = (event) => {
		handlers.onError?.(event);
	};

	return () => source.close();
}
