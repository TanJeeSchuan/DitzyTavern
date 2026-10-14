import { afterEach, describe, expect, test } from "bun:test";
import { NetworkError } from "./lib/request-outcome";

const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, "window", {
	configurable: true,
	value: { location: { origin: "http://localhost" } },
});
const { loadConversation } = await import("./conversation");
const installFetch = (handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => {
	globalThis.fetch = Object.assign(handler, { preconnect: () => {} });
};
afterEach(() => { globalThis.fetch = originalFetch; });

describe("Conversation refresh transport", () => {
	test("marks a refused connection for recovery", async () => {
		installFetch(async () => { throw new TypeError("Failed to fetch"); });
		await expect(loadConversation(42)).rejects.toBeInstanceOf(NetworkError);
	});

	test("does not classify an unusable response as a transport outage", async () => {
		installFetch(async () => Response.json({ error: "Unavailable" }, { status: 503 }));
		const request = loadConversation(42);
		await expect(request).rejects.toBeInstanceOf(Error);
		await expect(request).rejects.not.toBeInstanceOf(NetworkError);
	});

	test("passes cancellation to the summary read", async () => {
		const controller = new AbortController();
		let signal: AbortSignal | null | undefined;
		installFetch(async (_input, init) => {
			signal = init?.signal;
			return Response.json({ outcome: "not-found" }, { status: 404 });
		});
		expect(await loadConversation(42, controller.signal)).toBeNull();
		expect(signal).toBe(controller.signal);
	});
});
