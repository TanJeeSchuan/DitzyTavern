import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { flushHook, renderHook } from "../test-fixtures/render-hook";
import { foldNewer, useVisitSignal } from "./visit";

test("a visit survives the StrictMode remount and ends when its key changes", async () => {
	let key = 1;
	const hook = await renderHook(() => useVisitSignal(key), new QueryClient(), true);
	await flushHook();
	const first = hook.current;
	expect(first.aborted).toBe(false);

	key = 2;
	await hook.rerender();
	await flushHook();
	expect(first.aborted).toBe(true);
	expect(hook.current.aborted).toBe(false);

	await hook.unmount();
	await flushHook();
	expect(hook.current.aborted).toBe(true);
});

test("an older revision never replaces a newer cached copy", () => {
	const client = new QueryClient();
	const revisionOf = (value: { revision: number; name: string }) => value.revision;

	foldNewer(client, ["read"], { revision: 4, name: "newer" }, revisionOf);
	expect(foldNewer(client, ["read"], { revision: 3, name: "older" }, revisionOf)?.name).toBe("newer");
	expect(foldNewer(client, ["read"], { revision: 4, name: "same revision" }, revisionOf)?.name).toBe("same revision");
});

test("a copy folds over a cached not-found read", () => {
	const client = new QueryClient();
	client.setQueryData(["read"], null);
	expect(foldNewer(client, ["read"], { revision: 1 }, (value) => value.revision)).toEqual({ revision: 1 });
});
