import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { renderHook } from "../../client/test-fixtures/render-hook";
import { useDraftRun } from "./client-api";

test("a malformed draft event aborts its request before retry or unmount", async () => {
	const fetch = globalThis.fetch;
	let aborted = false;
	globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
		const body = new ReadableStream<Uint8Array>({
			start(stream) {
				init?.signal?.addEventListener("abort", () => { aborted = true; stream.close(); }, { once: true });
				stream.enqueue(new TextEncoder().encode("data: {\n\n"));
			},
		});
		return new Response(body);
	}, { preconnect: fetch.preconnect });
	try {
		const draft = await renderHook(() => useDraftRun({ conversationId: 1 }), new QueryClient());
		await draft.act(async () => { await draft.current.start({ conversationId: 1, person: "Maren" }); });
		expect(draft.current.run.status).toBe("failed");
		expect(aborted).toBe(true);
	} finally { globalThis.fetch = fetch; }
});
