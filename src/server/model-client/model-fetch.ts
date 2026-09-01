/** ==[HUMAN APPROVED]== Fetch is injected at the model-client boundary for deterministic transport tests. */
export type { ModelFetch } from "./types";

export class ModelFetchTimeoutError extends Error {
	constructor() {
		super("The model endpoint request timed out.");
		this.name = "ModelFetchTimeoutError";
	}
}

/**
 * ==[HUMAN APPROVED]== Applies a real deadline to injected fetches. The caller's signal is still
 * honored, while compliant transports are aborted when the deadline expires.
 */
export async function fetchWithTimeout(
	fetcher: import("./types").ModelFetch,
	input: RequestInfo | URL,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const callerSignal = init.signal;
	const abortFromCaller = () => controller.abort(callerSignal?.reason);
	if (callerSignal?.aborted === true) abortFromCaller();
	else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const request = fetcher(input, { ...init, signal: controller.signal });
	try {
		return await Promise.race([
			request,
			new Promise<Response>((_, reject) => {
				const check = () => {
					if (controller.signal.aborted && callerSignal?.aborted !== true) {
						reject(new ModelFetchTimeoutError());
					}
				};
				controller.signal.addEventListener("abort", check, { once: true });
			}),
		]);
	} finally {
		clearTimeout(timeout);
		callerSignal?.removeEventListener("abort", abortFromCaller);
	}
}

/** ==[HUMAN APPROVED]== Reads at most maxBytes and cancels the stream as soon as it exceeds the cap. */
export async function readBoundedResponse(
	response: Response,
	maxBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> {
	if (response.body === null) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		return bytes.byteLength > maxBytes
			? { bytes: bytes.slice(0, maxBytes), truncated: true }
			: { bytes, truncated: false };
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				return { bytes: joinBytes(chunks, maxBytes), truncated: true };
			}
			chunks.push(next.value);
		}
		return { bytes: joinBytes(chunks, total), truncated: false };
	} finally {
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
