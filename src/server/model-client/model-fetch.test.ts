import { describe, expect, test } from "bun:test";
import { fetchWithTimeout, ModelFetchTimeoutError, readBoundedResponse } from "./model-fetch";

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

		const result = await fetchWithTimeout(
			fetcher,
			"https://models.example.test",
			{},
			1_000,
			(response, signal) => readBoundedResponse(response, bodyBytes.byteLength, signal),
		);

		expect(result.truncated).toBe(false);
		expect(new TextDecoder().decode(result.bytes)).toBe(bodyText);
	});

	test("applies the deadline while consuming a response body", async () => {
		let cancelled = false;
		const fetcher = async (_input: RequestInfo | URL, _init?: RequestInit) => {
			const body = new ReadableStream<Uint8Array>({
				cancel() {
					cancelled = true;
				},
			});
			return new Response(body);
		};

		await expect(fetchWithTimeout(
			fetcher,
			"https://models.example.test",
			{},
			10,
			(response, signal) => readBoundedResponse(response, 100, signal),
		)).rejects.toBeInstanceOf(ModelFetchTimeoutError);
		expect(cancelled).toBe(true);
	});

	test("cancels body consumption when the caller aborts", async () => {
		const controller = new AbortController();
		let cancelled = false;
		let consuming!: () => void;
		const bodyStarted = new Promise<void>((resolve) => { consuming = resolve; });
		const fetcher = async () => new Response(new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		}));
		const request = fetchWithTimeout(
			fetcher,
			"https://models.example.test",
			{ signal: controller.signal },
			1_000,
			(response, signal) => {
				consuming();
				return readBoundedResponse(response, 100, signal);
			},
		);

		await bodyStarted;
		controller.abort();
		await expect(request).rejects.toMatchObject({ name: "AbortError" });
		expect(cancelled).toBe(true);
	});
});
