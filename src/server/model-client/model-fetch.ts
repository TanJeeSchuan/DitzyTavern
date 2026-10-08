/** @approved Fetch is injected at the model-client boundary for deterministic transport tests. */
export type { ModelFetch } from "./types";

export class ModelFetchTimeoutError extends Error {
	constructor() {
		super("The model endpoint request timed out.");
		this.name = "ModelFetchTimeoutError";
	}
}

/** @approved
 * Applies one real deadline to injected fetches and the caller-supplied
 * response consumer. The caller's signal is still honored, while compliant transports are
 * aborted when the deadline expires.
 */
export async function fetchWithTimeout<T>(
	fetcher: import("./types").ModelFetch,
	input: RequestInfo | URL,
	init: RequestInit,
	timeoutMs: number,
	consume: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const callerSignal = init.signal;
	callerSignal?.throwIfAborted();
	const abortFromCaller = () => controller.abort(callerSignal?.reason);
	callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
	let rejectAborted!: () => void;
	const aborted = new Promise<never>((_, reject) => {
		rejectAborted = () => reject(controller.signal.reason);
	});
	controller.signal.addEventListener("abort", rejectAborted, { once: true });
	const timeout = setTimeout(() => controller.abort(new ModelFetchTimeoutError()), timeoutMs);
	try {
		const operation = Promise.resolve().then(async () => {
			controller.signal.throwIfAborted();
			const response = await fetcher(input, { ...init, signal: controller.signal });
			controller.signal.throwIfAborted();
			return consume(response, controller.signal);
		});
		return await Promise.race([operation, aborted]);
	} finally {
		clearTimeout(timeout);
		controller.signal.removeEventListener("abort", rejectAborted);
		callerSignal?.removeEventListener("abort", abortFromCaller);
	}
}

/** @approved Reads at most maxBytes and cancels the stream as soon as it exceeds the cap. */
export async function readBoundedResponse(
	response: Response,
	maxBytes: number,
	signal: AbortSignal,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> {
	signal.throwIfAborted();
	if (response.body === null) return { bytes: new Uint8Array(), truncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let onAbort!: () => void;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => {
			void reader.cancel(signal.reason).catch(() => undefined);
			reject(signal.reason);
		};
	});
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			const next = await Promise.race([reader.read(), aborted]);
			if (next.done) break;
			total += next.value.byteLength;
			chunks.push(next.value);
			if (total > maxBytes) {
				void reader.cancel().catch(() => undefined);
				return { bytes: joinBytes(chunks, maxBytes), truncated: true };
			}
		}
		return { bytes: joinBytes(chunks, total), truncated: false };
	} finally {
		signal.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
}

function joinBytes(chunks: readonly Uint8Array[], maxBytes: number): Uint8Array {
	const result = new Uint8Array(Math.min(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0), maxBytes));
	let offset = 0;
	for (const chunk of chunks) {
		if (offset >= result.byteLength) break;
		const length = Math.min(chunk.byteLength, result.byteLength - offset);
		result.set(chunk.subarray(0, length), offset);
		offset += length;
	}
	return result;
}
