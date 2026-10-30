import { afterEach, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { followServerChanges, followsChanges } from "./server-changes";

class FakeEventSource extends EventTarget {
	static latest: FakeEventSource | undefined;
	constructor(readonly url: string) { super(); FakeEventSource.latest = this; }
	close() {}
}
const original = globalThis.EventSource;
afterEach(() => { Object.assign(globalThis, { EventSource: original }); });

test("a database change refetches the open reads that follow changes, leaving other reads and closed ones", async () => {
	Object.assign(globalThis, { EventSource: FakeEventSource });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	const fetched: string[] = [];
	const observe = (key: string, extra = {}) => {
		const observer = new QueryObserver(client, { queryKey: [key], queryFn: async () => { fetched.push(key); return key; }, ...extra });
		return observer.subscribe(() => {});
	};
	observe("digest", { meta: followsChanges });
	observe("draft");
	observe("closed", { meta: followsChanges })();
	await Bun.sleep(0);
	fetched.length = 0;
	followServerChanges(client);
	expect(FakeEventSource.latest?.url).toBe("/api/changes");
	FakeEventSource.latest?.dispatchEvent(new MessageEvent("change", { data: "1" }));
	await Bun.sleep(0);
	expect(fetched).toEqual(["digest"]);
});

test("a change during a read's first fetch reads again, so the older answer does not stand", async () => {
	Object.assign(globalThis, { EventSource: FakeEventSource });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	const answers = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
	let calls = 0;
	const observer = new QueryObserver(client, { queryKey: ["digest"], meta: followsChanges, queryFn: () => answers[calls++]!.promise }); // @approved Two answers for two fetches.
	observer.subscribe(() => {});
	followServerChanges(client);
	await Bun.sleep(0);
	FakeEventSource.latest?.dispatchEvent(new MessageEvent("change", { data: "1" }));
	await Bun.sleep(0);
	answers[0]!.resolve("before"); // @approved Created above.
	answers[1]!.resolve("after"); // @approved Created above.
	await Bun.sleep(0);
	expect(calls).toBe(2);
	expect(observer.getCurrentResult().data).toBe("after");
});

test("changes arriving faster than a read finishes let it land, then read once more", async () => {
	Object.assign(globalThis, { EventSource: FakeEventSource });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	const answers = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
	let calls = 0;
	const observer = new QueryObserver(client, { queryKey: ["memory"], meta: followsChanges, queryFn: () => answers[calls++]!.promise }); // @approved Two answers for two fetches.
	observer.subscribe(() => {});
	followServerChanges(client);
	await Bun.sleep(0);
	for (const seq of ["1", "2", "3"]) FakeEventSource.latest?.dispatchEvent(new MessageEvent("change", { data: seq }));
	await Bun.sleep(0);
	expect(calls).toBe(1);
	answers[0]!.resolve("slow"); // @approved Created above.
	await Bun.sleep(0);
	expect(calls).toBe(2);
	answers[1]!.resolve("latest"); // @approved Created above.
	await Bun.sleep(0);
	expect(observer.getCurrentResult().data).toBe("latest");
});
