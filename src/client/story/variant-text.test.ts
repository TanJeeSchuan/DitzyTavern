import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { flushHook, renderHook } from "../test-fixtures/render-hook";
import { useVariantsText } from "./variant-text";
import type { StoryVariant } from "../story";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("a closed Swipe browser releases its query observers and reopens with loaded text", async () => {
	let requests = 0;
	globalThis.fetch = Object.assign(async () => {
		requests++;
		return Response.json({ content: "The other take.", reasoning: "" });
	}, { preconnect() {} });
	const variants: StoryVariant[] = [
		{ id: 1, position: 1, content: "The first take.", empty: false, hasReasoning: false },
		{ id: 2, position: 2, content: null, empty: false, hasReasoning: false },
	];
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	let open = false;
	const hook = await renderHook(() => useVariantsText(1, 1, variants, open), client);
	const observers = () => client.getQueryCache().getAll().reduce((count, query) => count + query.getObserversCount(), 0);
	expect(observers()).toBe(0);
	expect(requests).toBe(0);
	open = true;
	await hook.rerender();
	await flushHook();
	expect(hook.current.map(({ content }) => content)).toEqual(["The first take.", "The other take."]);
	expect(requests).toBe(1);
	open = false;
	await hook.rerender();
	expect(observers()).toBe(0);
	open = true;
	await hook.rerender();
	expect(hook.current[1]?.content).toBe("The other take.");
	expect(requests).toBe(1);
});
