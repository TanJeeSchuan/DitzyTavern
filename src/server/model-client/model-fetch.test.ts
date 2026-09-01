import { describe, expect, test } from "bun:test";
import { fetchWithTimeout, readBoundedResponse } from "./model-fetch";

describe("Model fetch", () => {
	test("keeps a successful response body readable after fetch resolves", async () => {
		const bodyText = JSON.stringify({ data: [{ id: "test-model" }] });
		const bodyBytes = new TextEncoder().encode(bodyText);
		const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
			const signal = init?.signal;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					const abort = () => controller.error(new DOMException("The request was aborted.", "AbortError"));
					if (signal?.aborted === true) abort();
					else signal?.addEventListener("abort", abort, { once: true });
				},
				pull(controller) {
					controller.enqueue(bodyBytes);
					controller.close();
				},
			});
			return new Response(body);
		};

		const response = await fetchWithTimeout(fetcher, "https://models.example.test", {}, 1_000);
		const result = await readBoundedResponse(response, bodyBytes.byteLength);

		expect(result.truncated).toBe(false);
		expect(new TextDecoder().decode(result.bytes)).toBe(bodyText);
	});
});
